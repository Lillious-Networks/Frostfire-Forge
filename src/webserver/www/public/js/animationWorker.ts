self.onmessage = async function (e) {
  const animationData = e.data;

  try {
    if (!animationData?.data?.data) {
      self.postMessage({ error: "No animation data" });
      return;
    }

    // @ts-expect-error - pako is loaded in index.html
    const inflatedData = pako.inflate(new Uint8Array(animationData.data.data));

    // @ts-expect-error - parseAPNG is loaded in index.html
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

    self.postMessage({ framesInfo });
  } catch (error: any) {
    self.postMessage({ error: error.message });
  }
};
