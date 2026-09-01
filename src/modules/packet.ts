// Module-level singletons: encode/decode sit on the hottest path in the engine
// (every packetManager.* call, every inbound frame). Allocating a fresh
// TextEncoder/TextDecoder per call was measurable at high player counts.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const packet = {
  decode(data: ArrayBuffer) {
    return decoder.decode(data);
  },
  encode(data: string) {
    return encoder.encode(data);
  },
};

export default packet;
