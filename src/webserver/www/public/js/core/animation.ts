async function initializeAnimationWithWorker(animationData: any): Promise<any> {
  if (!animationData?.data?.data) return null;

  return new Promise((resolve) => {
    const worker = new Worker('animationWorker.js');

    worker.onmessage = (event) => {
      const { framesInfo, error } = event.data;
      if (error) {
        console.error('Animation Worker error:', error);
        resolve(null);
      } else {
        // Now create actual Image elements *on the main thread* to avoid worker complexity
        // We'll create empty Image objects for each frame as a placeholder
        // You can enhance this by sending URLs or blobs from server or worker

        const frames = framesInfo.map((frame : any) => {
          const img = new Image(frame.width, frame.height);
          // You will need to assign img.src somewhere after
          // For now, leave blank or assign a placeholder
          return {
            imageElement: img,
            width: frame.width,
            height: frame.height,
            delay: frame.delay
          };
        });

        resolve({
          frames,
          currentFrame: 0,
          lastFrameTime: performance.now()
        });
      }
      worker.terminate();
    };

    worker.postMessage(animationData);
  });
}

export { initializeAnimationWithWorker };