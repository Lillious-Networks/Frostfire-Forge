const packet = {
  decode(data: ArrayBuffer) {
    const decoder = new TextDecoder();
    return decoder.decode(data);
  },
  encode(data: string) {
    const encoder = new TextEncoder();
    return encoder.encode(data);
  },
};

export default packet;