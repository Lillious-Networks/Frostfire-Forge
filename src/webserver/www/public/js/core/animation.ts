async function initializeAnimationWithWorker(animationData: any, existingFrames: any[] = []): Promise<any> {
  if (!animationData?.data?.data) return null;

  return new Promise((resolve) => {
    const worker = new Worker('animationWorker.js');

    worker.onmessage = async (event) => {
      const { framesInfo, error, frameBuffers } = event.data;
      if (error) {
        console.error('Animation Worker error:', error);
        resolve(null);
        worker.terminate();
        return;
      }

      // Create or reuse Image objects
      const frames = await Promise.all(framesInfo.map(async (frame: any, idx: number) => {
        const img = existingFrames[idx]?.imageElement || new Image(frame.width, frame.height);

        // Convert ArrayBuffer to Blob URL for immediate rendering
        if (frameBuffers?.[idx]) {
          const blob = new Blob([frameBuffers[idx]], { type: 'image/png' });
          img.src = URL.createObjectURL(blob);
        }

        return {
          imageElement: img,
          width: frame.width,
          height: frame.height,
          delay: frame.delay
        };
      }));

      resolve({
        frames,
        currentFrame: 0,
        lastFrameTime: performance.now()
      });

      worker.terminate();
    };

    worker.postMessage(animationData);
  });
}

export { initializeAnimationWithWorker };
