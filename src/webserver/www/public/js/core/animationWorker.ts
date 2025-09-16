self.onmessage = async function (e) {
  const animationData = e.data;

  try {
    if (!animationData?.data?.data) {
      self.postMessage({ error: "No animation data" });
      return;
    }

    // @ts-expect-error - pako loaded in index.html
    const inflatedData = pako.inflate(new Uint8Array(animationData.data.data));

    // @ts-expect-error - parseAPNG loaded in index.html
    const apng = parseAPNG(inflatedData.buffer);

    if (apng instanceof Error) {
      self.postMessage({ error: "Failed to parse APNG" });
      return;
    }

    const framesInfo = apng.frames.map((frame: any) => ({
      width: frame.width,
      height: frame.height,
      delay: frame.delay,
    }));

    // Extract raw frame data for main thread to create blobs
    const frameBuffers = apng.frames.map((frame: any) => frame.data.buffer);

    self.postMessage({ framesInfo, frameBuffers });
  } catch (error: any) {
    self.postMessage({ error: error.message });
  }
};
