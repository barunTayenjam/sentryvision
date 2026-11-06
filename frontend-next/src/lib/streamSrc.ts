/**
 * go2rtc stream-name resolution for camera tiles.
 *
 * Everything a browser watches pulls the cheap profile (640x360 @ 10fps @
 * 250kbps). Measured at 267 kbps on cam1 versus 1500 kbps for the 720p
 * h264_low transcode, and the 1440p main stream the camera advertises at
 * ~4 Mbps is never requested by a client at all.
 *
 * `_cheap` is a dedicated go2rtc ffmpeg transcode, so it costs nothing when
 * nobody is watching, and it never disturbs the 24/7 `_low` transcode that
 * feeds the detection pipeline.
 *
 * Focus no longer changes quality: a focused tile used to request the bare
 * camera id (native 1440p), which was the single most expensive path in the
 * app. Full quality is now an explicit, time-boxed burst via streamSrcForHq.
 */
export const streamSrcForTile = (cameraId: string): string => `${cameraId}_cheap`;

/**
 * Full-quality burst — the 720p substream, never the native 1440p main
 * stream. Only used for the deliberate "HD 60s" button.
 */
export const streamSrcForHq = (cameraId: string): string => `${cameraId}_sub`;
