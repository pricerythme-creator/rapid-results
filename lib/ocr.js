// Main-thread OCR on Tesseract core (no worker, no fetch): works from file://
(function (root) {
  let M = null, api = null;
  async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }
  function b64(s) {
    const bin = atob(s); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  async function init() {
    if (api) return;
    M = await root.TesseractCore();
    M.FS.writeFile('/eng.traineddata', await gunzip(b64(root.ENG_TRAINEDDATA_GZ_B64)));
    api = new M.TessBaseAPI();
    if (api.Init(null, 'eng', 1) !== 0) throw Error('OCR engine failed to start');
    api.SetVariable('tessedit_pageseg_mode', '11');
  }
  async function read(bytes) {
    await init();
    M.FS.writeFile('/input', bytes);
    if (api.SetImageFile(1, 0) === 1) throw Error('Could not read this image');
    api.Recognize(null);
    const text = api.GetUTF8Text();
    const words = [];
    const ri = api.GetIterator();
    const W = M.RIL_WORD;
    ri.Begin();
    do {
      if (ri.IsAtBeginningOf(W)) {
        const t = ri.GetUTF8Text(W);
        if (t) words.push({ text: t, bbox: ri.getBoundingBox(W) });
      }
    } while (ri.Next(W));
    api.Clear();
    return { text, words };
  }
  root.SnapshotOCR = { init, read };
})(typeof window !== 'undefined' ? window : globalThis);
