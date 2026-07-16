const assert = require('node:assert/strict');
const test = require('node:test');
const { safePrintFFmpegArguments } = require(process.env.MEDIA_HELPERS_MODULE || '../dist/media-helpers');

function print(args) {
    const messages = [];
    safePrintFFmpegArguments({
        log(message) {
            messages.push(message);
        },
    }, args);
    assert.equal(messages.length, 1);
    return messages[0];
}

test('safePrintFFmpegArguments redacts input URL credentials', () => {
    const output = print([
        '-i',
        'rtsp://user:password@example.com/stream',
        '-vcodec',
        'copy',
    ]);

    assert.equal(output, '-i rtsp:[REDACTED] -vcodec copy');
    assert.doesNotMatch(output, /user|password/);
});

test('safePrintFFmpegArguments preserves local input paths', () => {
    assert.equal(
        print(['-i', '/tmp/camera recording.mp4']),
        '-i /tmp/camera recording.mp4',
    );
});

test('safePrintFFmpegArguments always redacts SRTP parameters', () => {
    const output = print([
        '-srtp_in_suite',
        'AES_CM_128_HMAC_SHA1_80',
        '-srtp_in_params',
        'input-secret-base64',
        '-srtp_out_suite',
        'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params',
        'output-secret-base64',
    ]);

    assert.equal(output,
        '-srtp_in_suite AES_CM_128_HMAC_SHA1_80 -srtp_in_params [REDACTED] '
        + '-srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params [REDACTED]');
    assert.doesNotMatch(output, /input-secret|output-secret/);
});
