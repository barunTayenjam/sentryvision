const { chromium } = require('playwright');
async function measure(page, src) {
  return await page.evaluate(async (src) => {
    const pc = new RTCPeerConnection({});
    pc.addTransceiver('video', { direction: 'recvonly' });
    return await new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; try { pc.close(); } catch(e){} resolve(r); } };
      setTimeout(() => done({ error: 'overall timeout' }), 25000);
      pc.ontrack = (e) => {
        const v = document.createElement('video');
        v.muted = true; v.srcObject = e.streams[0];
        v.play().catch(()=>{});
        let frames = 0, firstT = 0, lastT = 0, lastTime = -1, width = 0, height = 0, dropped = -1;
        const t0 = performance.now();
        const tick = () => {
          if (v.currentTime !== lastTime && v.currentTime > 0) {
            if (firstT === 0) firstT = performance.now();
            lastT = performance.now(); lastTime = v.currentTime; frames++;
            width = v.videoWidth; height = v.videoHeight;
          }
          if (performance.now() - t0 < 12000) requestAnimationFrame(tick);
          else {
            try { const q = v.getVideoPlaybackQuality(); dropped = q.droppedVideoFrames; } catch(e){}
            done({ frames, spanMs: lastT - firstT, width, height, dropped, currentTime: +v.currentTime.toFixed(2), ready: v.readyState });
          }
        };
        requestAnimationFrame(tick);
      };
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const res = await fetch(`http://127.0.0.1:1984/api/webrtc?src=${src}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: offer.type, sdp: offer.sdp }),
          });
          if (!res.ok) { done({ error: 'http ' + res.status }); return; }
          const answer = await res.json();
          await pc.setRemoteDescription(answer);
        } catch (e) { done({ error: String(e) }); }
      })();
    });
  }, src);
}
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const src of ['cam2', 'cam2_low']) {
    const r = await measure(page, src);
    if (r.error) console.log(src, 'ERROR', r.error);
    else console.log(`${src}: ${(r.frames / (r.spanMs / 1000)).toFixed(1)} fps | ${r.frames} frames/${(r.spanMs/1000).toFixed(1)}s | ${r.width}x${r.height} | dropped=${r.dropped} | ready=${r.ready}`);
  }
  await browser.close();
})();
