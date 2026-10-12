/**
 * go2rtc stream-name resolution for camera tiles.
 *
 * Grid tiles pull a 720p substream; only the focused/fullscreen tile
 * requests the native 1440p main stream. The old tablet cannot decode
 * 1440p Main@L5.0 in real time (~1200 kbps of a 4 Mbps feed) — tiles
 * asking for native is what makes playback sluggish.
 *
 * go2rtc.yaml exposes `<id>_sub` as a relay of the `<id>_low` transcode
 * (already encoded 24/7 for detection), so substream tiles add zero
 * server cost and zero extra camera sessions.
 */
export const streamSrcForTile = (cameraId: string, focused: boolean): string =>
  focused ? cameraId : `${cameraId}_sub`;
