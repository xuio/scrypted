#!/usr/bin/env python3
"""Autonomous macOS Home preview scroll/capture/black-tile reproducer.

The script drives only the local Home.app window. A small signed Swift helper
owns the Accessibility and Screen Recording permissions; Python schedules the
scroll/capture sequence, performs temporal black-region detection, and records
JSONL evidence. It never reads or changes Scrypted configuration.
"""

from __future__ import annotations

import argparse
from array import array
import dataclasses
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterable, Sequence


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
SWIFT_SOURCE = SCRIPT_DIR / "home-preview-ui-driver.swift"
DEFAULT_APP = pathlib.Path.home() / "Applications" / "HomeKit Preview Harness.app"
DEFAULT_FFMPEG = pathlib.Path("/run/current-system/sw/bin/ffmpeg")
APP_IDENTIFIER = "com.xuio.scrypted.homekit-preview-harness"
APP_VERSION = "1.1.0"
BROKER_STARTUP_TIMEOUT_SECONDS = 15.0
BROKER_REQUEST_TIMEOUT_SECONDS = 45.0
BROKER_MAXIMUM_RESPONSE_BYTES = 1024 * 1024
HOME_SNAPSHOT_CACHE = pathlib.Path.home() / "Library" / "Caches" / "com.apple.homed" / "Snapshots"
HOME_CACHE_MAX_FILES = 32
HOME_CACHE_MAX_FILE_BYTES = 8 * 1024 * 1024
HOME_CACHE_MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_RAW_DETECTION_REGIONS = 32
MAX_ANNOTATED_TILE_REGIONS = 8


class HarnessError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_json_line(handle, event: dict[str, Any]) -> None:
    handle.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")
    handle.flush()


def run(command: Sequence[str], *, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        list(command),
        check=check,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True,
    )


def helper_binary(app: pathlib.Path) -> pathlib.Path:
    return app / "Contents" / "MacOS" / "home-preview-ui-driver"


def write_if_changed(path: pathlib.Path, content: str, mode: int) -> None:
    if path.exists() and path.read_text(encoding="utf-8") == content:
        os.chmod(path, mode)
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def install_helper(app: pathlib.Path, *, force: bool = False) -> pathlib.Path:
    binary = helper_binary(app)
    info = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>HomeKit Preview Harness</string>
<key>CFBundleExecutable</key><string>home-preview-ui-driver</string>
<key>CFBundleIdentifier</key><string>{APP_IDENTIFIER}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>HomeKit Preview Harness</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>{APP_VERSION}</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Capture the local Home window to detect intermittent black camera preview tiles.</string>
</dict></plist>
'''
    fingerprint = hashlib.sha256()
    fingerprint.update(SWIFT_SOURCE.read_bytes())
    fingerprint.update(b"\0")
    fingerprint.update(info.encode("utf-8"))
    source_hash = fingerprint.hexdigest()
    stamp = app / "Contents" / "Resources" / "source.sha256"
    if not force and binary.exists() and stamp.exists() and stamp.read_text().strip() == source_hash:
        return binary

    app.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    contents = app / "Contents"
    macos = contents / "MacOS"
    resources = contents / "Resources"
    macos.mkdir(parents=True, exist_ok=True, mode=0o700)
    resources.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary_binary = macos / f".home-preview-ui-driver.{os.getpid()}.tmp"
    compile_result = run([
        "/usr/bin/swiftc",
        "-O",
        "-parse-as-library",
        "-o",
        str(temporary_binary),
        str(SWIFT_SOURCE),
    ], check=False)
    if compile_result.returncode:
        raise HarnessError(f"Swift helper build failed:\n{compile_result.stderr.strip()}")
    os.chmod(temporary_binary, 0o755)
    os.replace(temporary_binary, binary)

    write_if_changed(contents / "Info.plist", info, 0o600)
    write_if_changed(stamp, source_hash + "\n", 0o600)
    sign = run(["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", APP_IDENTIFIER, str(app)], check=False)
    if sign.returncode:
        raise HarnessError(f"Could not sign helper app: {sign.stderr.strip()}")
    return binary


class AquaSessionBroker:
    """Launch and call the signed helper inside the logged-in Aqua session."""

    def __init__(self, app: pathlib.Path):
        self.app = app
        self.directory = pathlib.Path(tempfile.mkdtemp(
            prefix=f"home-preview-{os.getuid()}-{os.getpid()}-",
            dir="/tmp",
        ))
        os.chmod(self.directory, 0o700)
        self.socket_path = self.directory / "broker.sock"
        self.error_log = self.directory / "broker.err"
        self.pid: int | None = None
        self.started = False

    def _prepare_error_log(self) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(self.error_log, flags, 0o600)
        os.close(descriptor)
        os.chmod(self.error_log, 0o600)

    def _error_log_tail(self) -> str:
        try:
            metadata = self.error_log.lstat()
            if metadata.st_uid != os.geteuid() or not stat.S_ISREG(metadata.st_mode):
                return "broker stderr path is not a private regular file"
            data = self.error_log.read_bytes()
        except FileNotFoundError:
            return ""
        return data[-8192:].decode("utf-8", errors="replace").strip()

    def _remove_error_log_if_safe(self) -> None:
        try:
            metadata = self.error_log.lstat()
        except FileNotFoundError:
            return
        if metadata.st_uid != os.geteuid() or not stat.S_ISREG(metadata.st_mode):
            raise HarnessError(f"refusing to remove unsafe broker log: {self.error_log}")
        self.error_log.unlink()

    @staticmethod
    def _process_is_running(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    @classmethod
    def _wait_for_process_exit(cls, pid: int, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while cls._process_is_running(pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        return not cls._process_is_running(pid)

    def _validate_socket(self) -> None:
        metadata = self.socket_path.lstat()
        if not stat.S_ISSOCK(metadata.st_mode):
            raise HarnessError(f"broker path is not a Unix socket: {self.socket_path}")
        if metadata.st_uid != os.geteuid():
            raise HarnessError("broker socket is not owned by the current user")
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise HarnessError(
                f"broker socket has unsafe mode {stat.S_IMODE(metadata.st_mode):#o}"
            )

    def _request(self, arguments: Sequence[str], timeout: float) -> dict[str, Any]:
        self._validate_socket()
        request = json.dumps(
            {"arguments": list(arguments)},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        response = bytearray()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(timeout)
            connection.connect(str(self.socket_path))
            connection.sendall(request)
            while b"\n" not in response:
                chunk = connection.recv(64 * 1024)
                if not chunk:
                    raise HarnessError("broker closed without a complete JSON response")
                response.extend(chunk)
                if len(response) > BROKER_MAXIMUM_RESPONSE_BYTES:
                    raise HarnessError("broker response exceeds size limit")
        line, _, trailing = response.partition(b"\n")
        if trailing:
            raise HarnessError("broker returned unexpected data after its JSON response")
        try:
            result = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HarnessError(f"invalid broker JSON: {line[:200]!r}") from error
        if not isinstance(result, dict):
            raise HarnessError("broker response is not a JSON object")
        return result

    def _remove_socket_if_safe(self) -> None:
        try:
            metadata = self.socket_path.lstat()
        except FileNotFoundError:
            return
        if metadata.st_uid != os.geteuid() or not stat.S_ISSOCK(metadata.st_mode):
            raise HarnessError(f"refusing to remove unsafe broker path: {self.socket_path}")
        self.socket_path.unlink()

    def start(self) -> None:
        if self.started:
            return
        self._remove_socket_if_safe()
        self._prepare_error_log()
        completed = run([
            "/usr/bin/open", "-n",
            "--stdin", "/dev/null",
            "--stdout", "/dev/null",
            "--stderr", str(self.error_log),
            str(self.app), "--args",
            "broker", str(self.socket_path),
        ], check=False)
        if completed.returncode:
            broker_error = self._error_log_tail()
            raise HarnessError(
                "could not launch helper in the Aqua session: "
                + (completed.stderr.strip() or completed.stdout.strip() or broker_error)
            )
        deadline = time.monotonic() + BROKER_STARTUP_TIMEOUT_SECONDS
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                ping = self._request(["ping"], timeout=0.5)
                if not ping.get("ok") or not isinstance(ping.get("pid"), int):
                    raise HarnessError("broker ping returned an invalid response")
                self.pid = ping["pid"]
                self.started = True
                return
            except (FileNotFoundError, ConnectionError, OSError, HarnessError) as error:
                last_error = error
                time.sleep(0.05)
        broker_error = self._error_log_tail()
        detail = f"; broker stderr: {broker_error}" if broker_error else ""
        raise HarnessError(
            f"Aqua helper broker did not become ready at {self.socket_path}: "
            f"{last_error}{detail}"
        )

    def call(self, *arguments: str) -> dict[str, Any]:
        self.start()
        try:
            return self._request(arguments, timeout=BROKER_REQUEST_TIMEOUT_SECONDS)
        except (ConnectionError, OSError, HarnessError):
            # A crashed agent leaves only a socket inode. Relaunch once; the
            # private per-run directory makes removing that inode race-free.
            self.started = False
            self.pid = None
            self._remove_socket_if_safe()
            self.start()
            return self._request(arguments, timeout=BROKER_REQUEST_TIMEOUT_SECONDS)

    def close(self) -> None:
        broker_pid = self.pid
        if self.socket_path.exists():
            try:
                self._request(["shutdown"], timeout=2.0)
            except (FileNotFoundError, ConnectionError, OSError, HarnessError):
                pass
        deadline = time.monotonic() + 2.0
        while self.socket_path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self._remove_socket_if_safe()
        process_stopped = True
        if broker_pid is not None:
            process_stopped = self._wait_for_process_exit(broker_pid, 2.0)
            if not process_stopped:
                try:
                    os.kill(broker_pid, signal.SIGTERM)
                except ProcessLookupError:
                    process_stopped = True
                else:
                    process_stopped = self._wait_for_process_exit(broker_pid, 1.0)
        self._remove_error_log_if_safe()
        try:
            self.directory.rmdir()
        except OSError:
            pass
        self.started = False
        self.pid = None
        if not process_stopped:
            raise HarnessError(f"Aqua helper broker process {broker_pid} did not exit")

    def __enter__(self) -> "AquaSessionBroker":
        try:
            self.start()
        except Exception:
            self.close()
            raise
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()


def helper_call(helper: pathlib.Path | AquaSessionBroker, *arguments: str) -> dict[str, Any]:
    if isinstance(helper, AquaSessionBroker):
        result = helper.call(*arguments)
        error_detail = ""
        return_code = 0
    else:
        completed = run([str(helper), *arguments], check=False)
        output = completed.stdout.strip().splitlines()
        if not output:
            raise HarnessError(f"helper produced no JSON: {completed.stderr.strip()}")
        try:
            result = json.loads(output[-1])
        except json.JSONDecodeError as error:
            raise HarnessError(f"invalid helper JSON: {output[-1]!r}") from error
        error_detail = completed.stderr.strip()
        return_code = completed.returncode
    if return_code or not result.get("ok"):
        raise HarnessError(result.get("error") or error_detail or "helper failed")
    return result


def permission_status(
    helper: pathlib.Path | AquaSessionBroker,
    request: bool = False,
) -> dict[str, Any]:
    return helper_call(helper, "status", *(["--request"] if request else []))


def parse_pgm(data: bytes) -> tuple[int, int, bytes]:
    if not data.startswith(b"P5"):
        raise HarnessError("ffmpeg did not return a binary PGM")
    position = 2
    tokens: list[bytes] = []
    while len(tokens) < 3:
        while position < len(data) and data[position] in b" \t\r\n":
            position += 1
        if position < len(data) and data[position] == ord("#"):
            while position < len(data) and data[position] not in b"\r\n":
                position += 1
            continue
        start = position
        while position < len(data) and data[position] not in b" \t\r\n":
            position += 1
        tokens.append(data[start:position])
    while position < len(data) and data[position] in b" \t\r\n":
        position += 1
    width, height, maximum = map(int, tokens)
    if maximum != 255 or len(data) - position != width * height:
        raise HarnessError("unexpected PGM dimensions or depth")
    return width, height, data[position:]


def load_gray(path: pathlib.Path, ffmpeg: pathlib.Path, max_width: int = 960) -> tuple[int, int, bytes]:
    completed = subprocess.run([
        str(ffmpeg), "-v", "error", "-i", str(path),
        "-vf", f"scale='min({max_width},iw)':-2:flags=fast_bilinear,format=gray",
        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "pgm", "pipe:1",
    ], check=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if completed.returncode:
        raise HarnessError(f"ffmpeg decode failed: {completed.stderr.decode(errors='replace').strip()}")
    return parse_pgm(completed.stdout)


@dataclasses.dataclass(frozen=True)
class RegionMetrics:
    x: int
    y: int
    width: int
    height: int
    current_mean: float
    current_stddev: float
    current_black_fraction: float
    reference_mean: float
    reference_stddev: float
    reference_black_fraction: float
    mean_absolute_difference: float
    score: float
    evidence: str = "temporal"

    def as_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


class IntegralGrayFrame:
    def __init__(self, width: int, height: int, pixels: bytes):
        self.width = width
        self.height = height
        self.stride = width + 1
        size = self.stride * (height + 1)
        self.sums = array("Q", [0]) * size
        self.squares = array("Q", [0]) * size
        self.black = array("I", [0]) * size
        for y in range(1, height + 1):
            row_sum = 0
            row_square = 0
            row_black = 0
            source = (y - 1) * width
            target = y * self.stride
            previous = target - self.stride
            for x in range(1, width + 1):
                value = pixels[source + x - 1]
                row_sum += value
                row_square += value * value
                row_black += value <= 20
                position = target + x
                self.sums[position] = self.sums[previous + x] + row_sum
                self.squares[position] = self.squares[previous + x] + row_square
                self.black[position] = self.black[previous + x] + row_black

    def rectangle(self, plane: array, x: int, y: int, width: int, height: int) -> int:
        left = x
        right = x + width
        top = y
        bottom = y + height
        stride = self.stride
        return (
            plane[bottom * stride + right]
            - plane[top * stride + right]
            - plane[bottom * stride + left]
            + plane[top * stride + left]
        )


def region_metrics(
    current: IntegralGrayFrame,
    reference: IntegralGrayFrame,
    x: int,
    y: int,
    width: int,
    height: int,
) -> RegionMetrics:
    count = width * height
    current_sum = current.rectangle(current.sums, x, y, width, height)
    reference_sum = reference.rectangle(reference.sums, x, y, width, height)
    current_mean = current_sum / count
    reference_mean = reference_sum / count
    current_square = current.rectangle(current.squares, x, y, width, height)
    reference_square = reference.rectangle(reference.squares, x, y, width, height)
    current_stddev = math.sqrt(max(0.0, current_square / count - current_mean * current_mean))
    reference_stddev = math.sqrt(max(0.0, reference_square / count - reference_mean * reference_mean))
    current_black_fraction = current.rectangle(current.black, x, y, width, height) / count
    reference_black_fraction = reference.rectangle(reference.black, x, y, width, height) / count
    # For a candidate whose current frame is overwhelmingly black, the mean
    # separation is the conservative lower bound on the per-pixel difference.
    mean_absolute_difference = abs(reference_mean - current_mean)
    score = (
        current_black_fraction * 3
        + max(0.0, reference_black_fraction - current_black_fraction) * -1
        + min(3.0, mean_absolute_difference / 25)
        + min(2.0, reference_stddev / 20)
        - min(2.0, current_stddev / 20)
    )
    return RegionMetrics(
        x=x, y=y, width=width, height=height,
        current_mean=current_mean,
        current_stddev=current_stddev,
        current_black_fraction=current_black_fraction,
        reference_mean=reference_mean,
        reference_stddev=reference_stddev,
        reference_black_fraction=reference_black_fraction,
        mean_absolute_difference=mean_absolute_difference,
        score=score,
    )


def intersection_over_union(a: RegionMetrics, b: RegionMetrics) -> float:
    left = max(a.x, b.x)
    top = max(a.y, b.y)
    right = min(a.x + a.width, b.x + b.width)
    bottom = min(a.y + a.height, b.y + b.height)
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    union = a.width * a.height + b.width * b.height - intersection
    return intersection / union


def plane_metrics(
    frame: IntegralGrayFrame,
    x: int,
    y: int,
    width: int,
    height: int,
) -> tuple[float, float, float]:
    count = width * height
    total = frame.rectangle(frame.sums, x, y, width, height)
    mean = total / count
    squares = frame.rectangle(frame.squares, x, y, width, height)
    stddev = math.sqrt(max(0.0, squares / count - mean * mean))
    black_fraction = frame.rectangle(frame.black, x, y, width, height) / count
    return mean, stddev, black_fraction


def row_neighbor_metrics(
    frame: IntegralGrayFrame,
    x: int,
    y: int,
    width: int,
    height: int,
) -> tuple[float, float, float] | None:
    """Find textured media aligned with a candidate camera preview tile."""
    best: tuple[float, float, float] | None = None
    best_score = -math.inf
    horizontal_offsets = sorted({
        int(width * ratio)
        for ratio in (1.08, 1.16, 1.24, 1.34, 1.48)
    })
    vertical_offsets = sorted({-height // 10, 0, height // 10})
    for direction in (-1, 1):
        for horizontal_offset in horizontal_offsets:
            neighbor_x = x + direction * horizontal_offset
            if neighbor_x < int(frame.width * 0.14) or neighbor_x + width > frame.width - 8:
                continue
            for vertical_offset in vertical_offsets:
                neighbor_y = y + vertical_offset
                if neighbor_y < 0 or neighbor_y + height > frame.height:
                    continue
                mean, stddev, black_fraction = plane_metrics(
                    frame, neighbor_x, neighbor_y, width, height,
                )
                # A neighboring camera view should contain texture and should
                # not itself be an almost-solid placeholder. Bright and dark
                # real scenes both satisfy this variance-based test.
                quadrant_width = width // 2
                quadrant_height = height // 2
                textured_quadrants = sum(
                    plane_metrics(
                        frame,
                        neighbor_x + quadrant_x,
                        neighbor_y + quadrant_y,
                        quadrant_width,
                        quadrant_height,
                    )[1] >= 8
                    for quadrant_y in (0, height - quadrant_height)
                    for quadrant_x in (0, width - quadrant_width)
                )
                if (
                    stddev < 14
                    or black_fraction > 0.72
                    or mean < 24
                    or textured_quadrants < 3
                ):
                    continue
                score = stddev + min(mean, 160) / 12 - black_fraction * 20
                if score > best_score:
                    best_score = score
                    best = (mean, stddev, black_fraction)
    return best


def absolute_black_regions(
    current_frame: tuple[int, int, bytes],
) -> list[RegionMetrics]:
    """Detect persistent black camera tiles without relying on a good reference.

    Home's camera media is approximately 16:9 and laid out in horizontal rows.
    Requiring a same-sized textured neighbor distinguishes a failed preview from
    the dark sidebar, control cards, separators, and other non-camera surfaces.
    """
    width, height, pixels = current_frame
    frame = IntegralGrayFrame(width, height, pixels)
    candidates: list[RegionMetrics] = []
    widths = sorted({128} | {
        max(128, int(width * ratio))
        for ratio in (0.16, 0.18, 0.20, 0.22, 0.25, 0.28, 0.31)
        if max(128, int(width * ratio)) <= min(420, width - 32)
    })
    minimum_x = int(width * 0.14)
    minimum_y = int(height * 0.07)
    maximum_y = int(height * 0.92)
    for window_width in widths:
        window_height = max(72, int(window_width * 9 / 16))
        if window_height >= height:
            continue
        step_x = max(6, window_width // 20)
        step_y = max(4, window_height // 18)
        last_y = max(minimum_y, maximum_y - window_height)
        y_positions = sorted({
            *range(minimum_y, last_y + 1, step_y),
            last_y,
        })
        last_x = width - window_width
        x_positions = sorted({
            *range(minimum_x, last_x + 1, step_x),
            last_x,
        })
        for y in y_positions:
            for x in x_positions:
                mean, stddev, black_fraction = plane_metrics(
                    frame, x, y, window_width, window_height,
                )
                if black_fraction < 0.82 or mean > 30 or stddev > 58:
                    continue
                neighbor = row_neighbor_metrics(
                    frame, x, y, window_width, window_height,
                )
                if neighbor is None:
                    continue
                neighbor_mean, neighbor_stddev, neighbor_black_fraction = neighbor
                candidates.append(RegionMetrics(
                    x=x,
                    y=y,
                    width=window_width,
                    height=window_height,
                    current_mean=mean,
                    current_stddev=stddev,
                    current_black_fraction=black_fraction,
                    reference_mean=neighbor_mean,
                    reference_stddev=neighbor_stddev,
                    reference_black_fraction=neighbor_black_fraction,
                    mean_absolute_difference=abs(neighbor_mean - mean),
                    score=(
                        black_fraction * 4
                        + max(0.0, 30 - mean) / 15
                        + min(2.5, neighbor_stddev / 20)
                    ),
                    evidence="absolute-row-context",
                ))
    selected: list[RegionMetrics] = []
    for candidate in sorted(candidates, key=lambda value: value.score, reverse=True):
        if all(intersection_over_union(candidate, existing) < 0.45 for existing in selected):
            selected.append(candidate)
        if len(selected) >= MAX_RAW_DETECTION_REGIONS:
            break
    return selected


def merge_regions(*groups: Iterable[RegionMetrics]) -> list[RegionMetrics]:
    selected: list[RegionMetrics] = []
    for candidate in sorted(
        (region for group in groups for region in group),
        key=lambda value: value.score,
        reverse=True,
    ):
        if all(intersection_over_union(candidate, existing) < 0.45 for existing in selected):
            selected.append(candidate)
        if len(selected) >= MAX_RAW_DETECTION_REGIONS:
            break
    return selected


def _nearest_true(values: Sequence[bool], preferred: int) -> int | None:
    if not values:
        return None
    preferred = min(max(preferred, 0), len(values) - 1)
    if values[preferred]:
        return preferred
    for distance in range(1, len(values)):
        left = preferred - distance
        if left >= 0 and values[left]:
            return left
        right = preferred + distance
        if right < len(values) and values[right]:
            return right
    return None


def _true_run(values: Sequence[bool], preferred: int) -> tuple[int, int] | None:
    seed = _nearest_true(values, preferred)
    if seed is None:
        return None
    start = seed
    end = seed + 1
    while start and values[start - 1]:
        start -= 1
    while end < len(values) and values[end]:
        end += 1
    return start, end


def refine_black_tile_regions(
    current_frame: tuple[int, int, bytes],
    candidates: Iterable[RegionMetrics],
) -> list[RegionMetrics]:
    """Turn overlapping search windows into the visible black tile bounds.

    The detector searches several sliding 16:9 windows, so its raw candidates
    are evidence windows rather than UI element frames.  Home's failed preview
    surfaces are much more uniformly black than their neighboring camera
    images.  Expanding from each candidate through rows and columns whose black
    coverage stays high recovers the actual full-height or half-height tile.
    This also keeps annotation coordinates in the analysis image; ``annotate``
    performs the single scale-back into the source screenshot.
    """
    width, height, pixels = current_frame
    frame = IntegralGrayFrame(width, height, pixels)
    refined: list[RegionMetrics] = []

    for candidate in candidates:
        center_x = min(max(candidate.x + candidate.width // 2, 0), width - 1)
        center_y = min(max(candidate.y + candidate.height // 2, 0), height - 1)
        band_width = min(max(24, candidate.width // 3), 96, width)
        band_left = min(max(center_x - band_width // 2, 0), width - band_width)

        row_black = [
            frame.rectangle(frame.black, band_left, y, band_width, 1) / band_width >= 0.72
            for y in range(height)
        ]
        vertical = _true_run(row_black, center_y)
        if vertical is None:
            continue
        top, bottom = vertical
        if bottom - top < 36:
            continue

        # Ignore a few rounded-corner pixels when measuring vertical columns.
        inset = min(3, max(0, (bottom - top - 1) // 8))
        column_top = top + inset
        column_height = max(1, bottom - top - inset * 2)
        column_black = [
            frame.rectangle(frame.black, x, column_top, 1, column_height) / column_height >= 0.72
            for x in range(width)
        ]
        horizontal = _true_run(column_black, center_x)
        if horizontal is None:
            continue
        left, right = horizontal
        if right - left < 64:
            continue

        # Re-evaluate rows across the recovered tile width. This removes a
        # candidate's original vertical offset and captures split-row tiles.
        row_black = [
            frame.rectangle(frame.black, left, y, right - left, 1) / (right - left) >= 0.70
            for y in range(height)
        ]
        vertical = _true_run(row_black, center_y)
        if vertical is not None:
            top, bottom = vertical

        # Include the anti-aliased one-pixel tile edge without reaching into a
        # neighboring camera cell.
        left = max(0, left - 1)
        top = max(0, top - 1)
        right = min(width, right + 1)
        bottom = min(height, bottom + 1)
        tile_width = right - left
        tile_height = bottom - top
        if tile_width < 64 or tile_height < 36:
            continue
        mean, stddev, black_fraction = plane_metrics(
            frame, left, top, tile_width, tile_height,
        )
        refined.append(dataclasses.replace(
            candidate,
            x=left,
            y=top,
            width=tile_width,
            height=tile_height,
            current_mean=mean,
            current_stddev=stddev,
            current_black_fraction=black_fraction,
            mean_absolute_difference=abs(candidate.reference_mean - mean),
            evidence=f"{candidate.evidence}-tile-bounds",
        ))

    selected: list[RegionMetrics] = []
    for candidate in sorted(refined, key=lambda value: value.score, reverse=True):
        if all(intersection_over_union(candidate, existing) < 0.72 for existing in selected):
            selected.append(candidate)
        if len(selected) >= MAX_ANNOTATED_TILE_REGIONS:
            break
    return selected


def black_regions(
    current_frame: tuple[int, int, bytes],
    reference_frame: tuple[int, int, bytes],
) -> list[RegionMetrics]:
    width, height, current = current_frame
    ref_width, ref_height, reference = reference_frame
    if (width, height) != (ref_width, ref_height):
        return []
    current_integral = IntegralGrayFrame(width, height, current)
    reference_integral = IntegralGrayFrame(width, height, reference)
    candidates: list[RegionMetrics] = []
    minimum = max(128, int(width * 0.14))
    maximum = min(int(width * 0.55), 480)
    sizes = sorted({
        minimum,
        int(minimum * 1.35),
        int(minimum * 1.7),
        maximum,
    })
    for window_width in sizes:
        window_width = min(window_width, width - 16)
        window_height = max(72, int(window_width * 9 / 16))
        if window_height >= height:
            continue
        step_x = max(8, window_width // 10)
        step_y = max(5, window_height // 12)
        last_y = height - window_height
        last_x = width - window_width
        y_positions = sorted({*range(0, last_y + 1, step_y), last_y})
        x_positions = sorted({*range(0, last_x + 1, step_x), last_x})
        for y in y_positions:
            for x in x_positions:
                metrics = region_metrics(
                    current_integral, reference_integral,
                    x, y, window_width, window_height,
                )
                if (
                    metrics.current_black_fraction >= 0.82
                    and metrics.current_mean <= 24
                    and metrics.reference_black_fraction <= 0.58
                    and metrics.reference_stddev >= 12
                    and metrics.mean_absolute_difference >= 18
                ):
                    candidates.append(metrics)
    selected: list[RegionMetrics] = []
    for candidate in sorted(candidates, key=lambda value: value.score, reverse=True):
        if all(intersection_over_union(candidate, existing) < 0.45 for existing in selected):
            selected.append(candidate)
        if len(selected) >= MAX_RAW_DETECTION_REGIONS:
            break
    return selected


def annotate(
    source: pathlib.Path,
    destination: pathlib.Path,
    regions: Iterable[RegionMetrics],
    source_width: int,
    source_height: int,
    analysis_width: int,
    analysis_height: int,
    ffmpeg: pathlib.Path,
) -> None:
    filters = []
    scale_x = source_width / analysis_width
    scale_y = source_height / analysis_height
    for region in regions:
        filters.append(
            "drawbox="
            f"x={round(region.x * scale_x)}:y={round(region.y * scale_y)}:"
            f"w={round(region.width * scale_x)}:h={round(region.height * scale_y)}:"
            "color=red@0.95:t=6"
        )
    if not filters:
        return
    completed = subprocess.run([
        str(ffmpeg), "-v", "error", "-i", str(source),
        "-vf", ",".join(filters), "-frames:v", "1", "-y", str(destination),
    ], check=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if completed.returncode:
        raise HarnessError(f"annotation failed: {completed.stderr.decode(errors='replace').strip()}")
    os.chmod(destination, 0o600)


def ensure_run_directory(explicit: str | None) -> pathlib.Path:
    if explicit:
        run_dir = pathlib.Path(explicit).expanduser().resolve()
    else:
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        run_dir = pathlib.Path.home() / "Library" / "Logs" / "Scrypted" / "HomeKitPreviewUI" / stamp
    run_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(run_dir, 0o700)
    return run_dir


def snapshot_logs(destination: pathlib.Path, seconds: int = 20) -> None:
    predicate = '(process == "Home") OR (process == "homed") OR (subsystem CONTAINS[c] "homekit")'
    with destination.open("xb") as output:
        completed = subprocess.run([
            "/usr/bin/log", "show", "--last", f"{seconds}s", "--style", "json",
            "--predicate", predicate,
        ], check=False, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.PIPE)
    os.chmod(destination, 0o600)
    if completed.returncode:
        destination.with_suffix(".error.txt").write_bytes(completed.stderr)


def capture_frame(
    helper: pathlib.Path | AquaSessionBroker,
    frames_dir: pathlib.Path,
    index: int,
    ffmpeg: pathlib.Path,
) -> tuple[dict[str, Any], tuple[int, int, bytes]]:
    path = frames_dir / f"frame-{index:06d}.png"
    started = time.monotonic()
    result = helper_call(helper, "capture", str(path))
    result["captureElapsedMs"] = round((time.monotonic() - started) * 1000, 3)
    result["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result, load_gray(path, ffmpeg)


def capture_home_snapshot_cache(
    run_dir: pathlib.Path,
    frame_index: int,
) -> dict[str, Any]:
    """Content-address the current Home snapshot files without changing them."""
    blobs_dir = run_dir / "home-cache" / "blobs"
    blobs_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(blobs_dir.parent, 0o700)
    os.chmod(blobs_dir, 0o700)
    entries: list[dict[str, Any]] = []
    errors: list[str] = []
    total_bytes = 0
    if not HOME_SNAPSHOT_CACHE.is_dir():
        return {
            "type": "home-snapshot-cache",
            "at": utc_now(),
            "frameIndex": frame_index,
            "entries": entries,
            "errors": ["snapshot cache directory is unavailable"],
        }
    try:
        paths = sorted(
            (path for path in HOME_SNAPSHOT_CACHE.glob("*/*") if path.is_file()),
            key=lambda path: (path.parent.name, path.name),
        )
    except OSError as error:
        paths = []
        errors.append(f"cache enumeration failed: {error}")
    for source in paths[:HOME_CACHE_MAX_FILES]:
        try:
            stat_result = source.stat()
            if stat_result.st_size > HOME_CACHE_MAX_FILE_BYTES:
                errors.append(f"oversized cache file skipped: {source.parent.name}/{source.name}")
                continue
            if total_bytes + stat_result.st_size > HOME_CACHE_MAX_TOTAL_BYTES:
                errors.append("cache capture total-byte limit reached")
                break
            content = source.read_bytes()
            if len(content) != stat_result.st_size:
                errors.append(f"cache file changed while reading: {source.parent.name}/{source.name}")
                continue
            total_bytes += len(content)
            sha256 = hashlib.sha256(content).hexdigest()
            blob = blobs_dir / f"{sha256}.jpg"
            if not blob.exists():
                temporary = blobs_dir / f".{sha256}.{os.getpid()}.tmp"
                with temporary.open("xb") as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(temporary, 0o600)
                try:
                    os.replace(temporary, blob)
                finally:
                    temporary.unlink(missing_ok=True)
            entries.append({
                "cacheDirectory": source.parent.name,
                "sourceName": source.name,
                "bytes": len(content),
                "mtimeNs": stat_result.st_mtime_ns,
                "sha256": sha256,
                "blob": str(blob),
            })
        except OSError as error:
            errors.append(f"cache read failed for {source.parent.name}/{source.name}: {error}")
    if len(paths) > HOME_CACHE_MAX_FILES:
        errors.append(f"cache file limit reached ({len(paths)} present)")
    return {
        "type": "home-snapshot-cache",
        "at": utc_now(),
        "frameIndex": frame_index,
        "entries": entries,
        "errors": errors,
        "totalBytesRead": total_bytes,
    }


def run_soak(
    arguments: argparse.Namespace,
    helper: AquaSessionBroker,
    binary: pathlib.Path,
) -> int:
    ffmpeg = pathlib.Path(arguments.ffmpeg)
    if not ffmpeg.is_file() or not os.access(ffmpeg, os.X_OK):
        raise HarnessError(f"ffmpeg is not executable: {ffmpeg}")
    run_dir = ensure_run_directory(arguments.run_dir)
    frames_dir = run_dir / "frames"
    frames_dir.mkdir(mode=0o700)
    events_path = run_dir / "events.jsonl"
    manifest_path = run_dir / "manifest.json"
    manifest = {
        "schema": "scrypted-homekit-preview-ui-soak/v1",
        "startedAt": utc_now(),
        "durationSeconds": arguments.duration,
        "captureOffsetsSeconds": arguments.capture_offsets,
        "scrollPixels": arguments.scroll_pixels,
        "helper": str(binary),
        "brokerPid": helper.pid,
        "brokerSocket": str(helper.socket_path),
        "ffmpeg": str(ffmpeg),
        "pid": os.getpid(),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(manifest_path, 0o600)

    end = time.monotonic() + arguments.duration
    frame_index = 0
    cycle = 0
    direction = 1
    references: dict[int, tuple[dict[str, Any], tuple[int, int, bytes]]] = {}
    incidents = 0
    with events_path.open("x", encoding="utf-8", buffering=1) as events:
        os.chmod(events_path, 0o600)
        helper_call(helper, "activate")
        write_json_line(events, {"type": "run-start", "at": utc_now(), **manifest})
        while time.monotonic() < end:
            cycle += 1
            scroll_at = time.monotonic()
            amount = direction * arguments.scroll_pixels
            scroll_result = helper_call(helper, "scroll", str(amount))
            write_json_line(events, {
                "type": "scroll", "at": utc_now(), "cycle": cycle,
                "direction": direction, "amount": amount, **scroll_result,
            })
            cycle_frames: list[tuple[dict[str, Any], tuple[int, int, bytes]]] = []
            for offset in arguments.capture_offsets:
                remaining = scroll_at + offset - time.monotonic()
                if remaining > 0:
                    time.sleep(remaining)
                if time.monotonic() >= end:
                    break
                frame_index += 1
                metadata, gray = capture_frame(helper, frames_dir, frame_index, ffmpeg)
                metadata.update({
                    "type": "frame", "at": utc_now(), "cycle": cycle,
                    "direction": direction, "offsetSeconds": offset,
                    "analysisWidth": gray[0], "analysisHeight": gray[1],
                })
                cycle_frames.append((metadata, gray))
                write_json_line(events, metadata)
                if arguments.capture_home_cache:
                    write_json_line(events, capture_home_snapshot_cache(run_dir, frame_index))

            if cycle_frames:
                settled_metadata, settled_gray = cycle_frames[-1]
                reference_entry = references.get(direction)
                reference_gray = reference_entry[1] if reference_entry else settled_gray
                for metadata, gray in cycle_frames:
                    is_settled = metadata is settled_metadata
                    temporal_regions = [] if is_settled else black_regions(gray, settled_gray)
                    if not is_settled and not temporal_regions and reference_entry:
                        temporal_regions = black_regions(gray, reference_gray)
                    absolute_regions = absolute_black_regions(gray)
                    regions = merge_regions(temporal_regions, absolute_regions)
                    if not regions:
                        continue
                    tile_regions = refine_black_tile_regions(gray, regions)
                    if not tile_regions:
                        tile_regions = regions
                    incidents += 1
                    source = pathlib.Path(metadata["path"])
                    annotated = run_dir / f"incident-{incidents:04d}.png"
                    annotate(
                        source, annotated, tile_regions,
                        int(metadata["width"]), int(metadata["height"]),
                        gray[0], gray[1], ffmpeg,
                    )
                    incident = {
                        "type": "black-tile-candidate",
                        "at": utc_now(),
                        "cycle": cycle,
                        "direction": direction,
                        "frame": str(source),
                        "annotated": str(annotated),
                        "settledReference": settled_metadata["path"],
                        "priorReference": reference_entry[0]["path"] if reference_entry else None,
                        "evidence": sorted({region.evidence for region in regions}),
                        "regions": [region.as_dict() for region in regions],
                        "tileRegions": [region.as_dict() for region in tile_regions],
                        "temporalRegions": [region.as_dict() for region in temporal_regions],
                        "absoluteRegions": [region.as_dict() for region in absolute_regions],
                    }
                    write_json_line(events, incident)
                    snapshot_logs(run_dir / f"incident-{incidents:04d}-home.jsonl")
                references[direction] = (settled_metadata, settled_gray)
            direction *= -1
            rest = scroll_at + arguments.cycle_seconds - time.monotonic()
            if rest > 0:
                time.sleep(min(rest, max(0.0, end - time.monotonic())))

        write_json_line(events, {
            "type": "run-complete", "at": utc_now(), "cycles": cycle,
            "frames": frame_index, "incidents": incidents,
        })
    print(json.dumps({
        "ok": True,
        "runDir": str(run_dir),
        "cycles": cycle,
        "frames": frame_index,
        "incidents": incidents,
    }, sort_keys=True))
    return 0


def comma_floats(value: str) -> list[float]:
    result = [float(item) for item in value.split(",") if item.strip()]
    if not result or any(item < 0 for item in result) or result != sorted(result):
        raise argparse.ArgumentTypeError("offsets must be sorted non-negative numbers")
    return result


def self_test_detector() -> int:
    width, height = 640, 360
    reference = bytes(
        40 + ((x * 7 + y * 11) % 180)
        for y in range(height)
        for x in range(width)
    )
    current = bytearray(reference)
    injected = (180, 90, 256, 144)
    left, top, region_width, region_height = injected
    for y in range(top, top + region_height):
        start = y * width + left
        current[start:start + region_width] = b"\x00" * region_width
    regions = black_regions(
        (width, height, bytes(current)),
        (width, height, reference),
    )
    if not regions:
        raise HarnessError("self-test did not detect the injected black tile")
    injected_area = RegionMetrics(
        x=left, y=top, width=region_width, height=region_height,
        current_mean=0, current_stddev=0, current_black_fraction=1,
        reference_mean=1, reference_stddev=1, reference_black_fraction=0,
        mean_absolute_difference=1, score=1,
    )
    if max(intersection_over_union(region, injected_area) for region in regions) < 0.25:
        raise HarnessError("self-test detection did not overlap the injected tile")
    refined = refine_black_tile_regions((width, height, bytes(current)), regions)
    if not refined or max(
        intersection_over_union(region, injected_area)
        for region in refined
    ) < 0.80:
        raise HarnessError("self-test did not recover the injected tile bounds")
    if black_regions((width, height, reference), (width, height, reference)):
        raise HarnessError("self-test produced a false positive for identical frames")

    # Persistent failure: the current and every temporal reference contain the
    # same black camera tile. Absolute row evidence must still find it.
    persistent_width, persistent_height = 960, 540
    persistent = bytearray(b"\xdc" * (persistent_width * persistent_height))
    for y in range(persistent_height):
        start = y * persistent_width
        persistent[start:start + 190] = b"\x1c" * 190  # dark sidebar
    tile_y, tile_width, tile_height = 100, 190, 107
    for tile_x in (220, 640):
        for y in range(tile_y, tile_y + tile_height):
            start = y * persistent_width + tile_x
            persistent[start:start + tile_width] = bytes(
                35 + ((x * 13 + y * 17) % 200)
                for x in range(tile_width)
            )
    persistent_tile = (430, tile_y, tile_width, tile_height)
    persistent_left, persistent_top, _, _ = persistent_tile
    for y in range(persistent_top, persistent_top + tile_height):
        start = y * persistent_width + persistent_left
        persistent[start:start + tile_width] = b"\x00" * tile_width
    # Sparse bright pixels model Home's age/status text over the black preview.
    for y in range(persistent_top + 76, persistent_top + 80):
        start = y * persistent_width + persistent_left + 58
        persistent[start:start + 44] = b"\xe8" * 44
    persistent_frame = (
        persistent_width,
        persistent_height,
        bytes(persistent),
    )
    if black_regions(persistent_frame, persistent_frame):
        raise HarnessError("temporal self-test unexpectedly detected persistent black")
    absolute_regions = absolute_black_regions(persistent_frame)
    persistent_area = RegionMetrics(
        x=persistent_left,
        y=persistent_top,
        width=tile_width,
        height=tile_height,
        current_mean=0,
        current_stddev=0,
        current_black_fraction=1,
        reference_mean=1,
        reference_stddev=1,
        reference_black_fraction=0,
        mean_absolute_difference=1,
        score=1,
        evidence="absolute-row-context",
    )
    if not absolute_regions or max(
        intersection_over_union(region, persistent_area)
        for region in absolute_regions
    ) < 0.35:
        raise HarnessError("absolute self-test did not detect persistent black camera tile")

    # The final Home camera column can be clipped by the window and split into
    # half-height cells. Keep a narrow absolute probe so its exact visible
    # bounds are still recovered instead of annotating a neighboring search
    # window.
    edge = bytearray(b"\xdc" * (persistent_width * persistent_height))
    edge_left, edge_top, edge_width, edge_height = 808, 100, 152, 73
    for y in range(edge_top, edge_top + edge_height):
        texture_start = y * persistent_width + 600
        edge[texture_start:texture_start + 208] = bytes(
            35 + ((x * 13 + y * 17) % 200)
            for x in range(208)
        )
        black_start = y * persistent_width + edge_left
        edge[black_start:black_start + edge_width] = b"\x00" * edge_width
    edge_frame = (persistent_width, persistent_height, bytes(edge))
    edge_candidates = absolute_black_regions(edge_frame)
    edge_refined = refine_black_tile_regions(edge_frame, edge_candidates)
    edge_area = dataclasses.replace(
        persistent_area,
        x=edge_left,
        y=edge_top,
        width=edge_width,
        height=edge_height,
    )
    if not edge_refined or max(
        intersection_over_union(region, edge_area)
        for region in edge_refined
    ) < 0.80:
        raise HarnessError("absolute self-test did not recover clipped half-tile bounds")

    # A similarly black, camera-shaped UI card without a textured row neighbor
    # must not be classified as a failed preview.
    isolated = bytearray(b"\xdc" * (persistent_width * persistent_height))
    isolated_left, isolated_top = 430, 340
    for y in range(isolated_top, isolated_top + tile_height):
        start = y * persistent_width + isolated_left
        isolated[start:start + tile_width] = b"\x00" * tile_width
    if absolute_black_regions((persistent_width, persistent_height, bytes(isolated))):
        raise HarnessError("absolute self-test classified an isolated dark UI card")
    print(json.dumps({
        "ok": True,
        "selfTest": "black-tile-detector",
        "detections": len(regions),
        "absoluteDetections": len(absolute_regions),
        "absoluteBest": absolute_regions[0].as_dict(),
        "best": regions[0].as_dict(),
    }, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default=str(DEFAULT_APP))
    parser.add_argument("--install", action="store_true", help="build/sign the dedicated helper app")
    parser.add_argument("--force-install", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--request-permissions", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--capture-home-cache", action="store_true",
        help="copy current Home snapshot cache JPEGs into private content-addressed evidence blobs",
    )
    parser.add_argument("--run-dir")
    parser.add_argument("--duration", type=int, default=300)
    parser.add_argument("--cycle-seconds", type=float, default=12.0)
    parser.add_argument("--capture-offsets", type=comma_floats, default=comma_floats("0.4,1,2,4,7,10"))
    parser.add_argument("--scroll-pixels", type=int, default=850)
    parser.add_argument("--ffmpeg", default=str(DEFAULT_FFMPEG))
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    if arguments.self_test:
        return self_test_detector()
    if arguments.duration < 1 or arguments.duration > 3600:
        raise HarnessError("duration must be 1 through 3600 seconds")
    if arguments.cycle_seconds <= max(arguments.capture_offsets):
        raise HarnessError("cycle-seconds must exceed the last capture offset")
    if not 100 <= abs(arguments.scroll_pixels) <= 4000:
        raise HarnessError("scroll-pixels must be 100 through 4000")
    app = pathlib.Path(arguments.app).expanduser().resolve()
    binary = install_helper(app, force=arguments.force_install) if (arguments.install or arguments.force_install) else helper_binary(app)
    if not binary.is_file():
        raise HarnessError("helper is not installed; run with --install")
    with AquaSessionBroker(app) as helper:
        status = permission_status(helper, request=arguments.request_permissions)
        if arguments.status or arguments.request_permissions:
            print(json.dumps(status, indent=2, sort_keys=True))
            if arguments.status and not arguments.request_permissions:
                return 0
        if not status.get("accessibility") or not status.get("screenRecording"):
            raise HarnessError(
                "HomeKit Preview Harness needs Accessibility and Screen Recording in "
                "System Settings > Privacy & Security. Grant both to the dedicated app, "
                "then rerun --status."
            )
        return run_soak(arguments, helper, binary)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HarnessError as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        raise SystemExit(2)
