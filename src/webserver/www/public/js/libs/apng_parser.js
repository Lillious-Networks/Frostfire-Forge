// First, declare all the error constants and helper functions
const errNotPNG = new Error('Not a PNG');
const errNotAPNG = new Error('Not an animated PNG');

function isNotPNG(err) { return err === errNotPNG; }
function isNotAPNG(err) { return err === errNotAPNG; }

const PNGSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 table and function
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = ((c & 1) !== 0) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    crc32Table[i] = c;
}

function crc32(bytes, start = 0, length = bytes.length - start) {
    let crc = -1;
    for (let i = start, l = start + length; i < l; i++) {
        crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[i]) & 0xFF];
    }
    return crc ^ (-1);
}

// Event Emitter implementation
class EventEmitter {
    constructor() {
        this._events = {};
    }

    on(event, listener) {
        if (!this._events[event]) {
            this._events[event] = [];
        }
        this._events[event].push(listener);
    }

    emit(event, ...args) {
        if (this._events[event]) {
            this._events[event].forEach(listener => listener(...args));
        }
    }
}

// Helper functions
function readString(bytes, off, length) {
    const chars = Array.prototype.slice.call(bytes.subarray(off, off + length));
    return String.fromCharCode.apply(String, chars);
}

function makeStringArray(x) {
    const res = new Uint8Array(x.length);
    for (let i = 0; i < x.length; i++) {
        res[i] = x.charCodeAt(i);
    }
    return res;
}

function subBuffer(bytes, start, length) {
    const a = new Uint8Array(length);
    a.set(bytes.subarray(start, start + length));
    return a;
}

function makeChunkBytes(type, dataBytes) {
    const crcLen = type.length + dataBytes.length;
    const bytes = new Uint8Array(crcLen + 8);
    const dv = new DataView(bytes.buffer);

    dv.setUint32(0, dataBytes.length);
    bytes.set(makeStringArray(type), 4);
    bytes.set(dataBytes, 8);
    const crc = crc32(bytes, 4, crcLen);
    dv.setUint32(crcLen + 4, crc);
    return bytes;
}

function makeDWordArray(x) {
    return new Uint8Array([(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff]);
}

function eachChunk(bytes, callback) {
    const dv = new DataView(bytes.buffer);
    let off = 8, type, length, res;
    do {
        length = dv.getUint32(off);
        type = readString(bytes, off + 4, 4);
        res = callback(type, bytes, off, length);
        off += 12 + length;
    } while (res !== false && type != 'IEND' && off < bytes.length);
}

// Class definitions
class Frame {
    constructor() {
        this.left = 0;
        this.top = 0;
        this.width = 0;
        this.height = 0;
        this.delay = 0;
        this.disposeOp = 0;
        this.blendOp = 0;
        this.imageData = null;
        this.imageElement = null;
        this.dataParts = [];
    }

    createImage() {
        if (this.imageElement) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(this.imageData);
            this.imageElement = document.createElement('img');
            this.imageElement.onload = () => {
                URL.revokeObjectURL(url);
                resolve();
            };
            this.imageElement.onerror = () => {
                URL.revokeObjectURL(url);
                this.imageElement = null;
                reject(new Error("Image creation error"));
            };
            this.imageElement.src = url;
        });
    }
}

class APNG {
    constructor() {
        this.width = 0;
        this.height = 0;
        this.numPlays = 0;
        this.playTime = 0;
        this.frames = [];
    }

    createImages() {
        return Promise.all(this.frames.map(f => f.createImage()));
    }

    getPlayer(context, autoPlay = false) {
        return this.createImages().then(() => new Player(this, context, autoPlay));
    }
}

class Player extends EventEmitter {
    constructor(apng, context, autoPlay) {
        super();
        this._apng = apng;
        this.context = context;
        this.playbackRate = 1.0;
        this._prevFrame = null;
        this._prevFrameData = null;
        this._currentFrameNumber = 0;
        this._ended = false;
        this._paused = true;
        this._numPlays = 0;
        this._rafId = null;
        
        this.stop();
        if (autoPlay) {
            this.play();
        }
    }

    // ... rest of Player implementation ...
}

// Main parsing function
function parseAPNG(buffer) {
    const bytes = new Uint8Array(buffer);

    if (Array.prototype.some.call(PNGSignature, (b, i) => b !== bytes[i])) {
        return errNotPNG;
    }

    let isAnimated = false;
    eachChunk(bytes, type => !(isAnimated = (type === 'acTL')));
    if (!isAnimated) {
        return errNotAPNG;
    }

    const preDataParts = [],
        postDataParts = [];
    let headerDataBytes = null,
        frame = null,
        frameNumber = 0,
        apng = new APNG();

    eachChunk(bytes, (type, bytes, off, length) => {
        const dv = new DataView(bytes.buffer);
        switch (type) {
            case 'IHDR':
                headerDataBytes = bytes.subarray(off + 8, off + 8 + length);
                apng.width = dv.getUint32(off + 8);
                apng.height = dv.getUint32(off + 12);
                break;
            case 'acTL':
                apng.numPlays = dv.getUint32(off + 8 + 4);
                break;
            case 'fcTL':
                if (frame) {
                    apng.frames.push(frame);
                    frameNumber++;
                }
                frame = new Frame();
                frame.width = dv.getUint32(off + 8 + 4);
                frame.height = dv.getUint32(off + 8 + 8);
                frame.left = dv.getUint32(off + 8 + 12);
                frame.top = dv.getUint32(off + 8 + 16);
                var delayN = dv.getUint16(off + 8 + 20);
                var delayD = dv.getUint16(off + 8 + 22);
                if (delayD === 0) delayD = 100;
                frame.delay = 1000 * delayN / delayD;
                if (frame.delay <= 10) frame.delay = 100;
                apng.playTime += frame.delay;
                frame.disposeOp = dv.getUint8(off + 8 + 24);
                frame.blendOp = dv.getUint8(off + 8 + 25);
                frame.dataParts = [];
                if (frameNumber === 0 && frame.disposeOp === 2) {
                    frame.disposeOp = 1;
                }
                break;
            case 'fdAT':
                if (frame) {
                    frame.dataParts.push(bytes.subarray(off + 8 + 4, off + 8 + length));
                }
                break;
            case 'IDAT':
                if (frame) {
                    frame.dataParts.push(bytes.subarray(off + 8, off + 8 + length));
                }
                break;
            case 'IEND':
                postDataParts.push(subBuffer(bytes, off, 12 + length));
                break;
            default:
                preDataParts.push(subBuffer(bytes, off, 12 + length));
        }
    });

    if (frame) {
        apng.frames.push(frame);
    }

    if (apng.frames.length == 0) {
        return errNotAPNG;
    }

    const preBlob = new Blob(preDataParts),
        postBlob = new Blob(postDataParts);

    apng.frames.forEach(frame => {
        var bb = [];
        bb.push(PNGSignature);
        headerDataBytes.set(makeDWordArray(frame.width), 0);
        headerDataBytes.set(makeDWordArray(frame.height), 4);
        bb.push(makeChunkBytes('IHDR', headerDataBytes));
        bb.push(preBlob);
        frame.dataParts.forEach(p => bb.push(makeChunkBytes('IDAT', p)));
        bb.push(postBlob);
        frame.imageData = new Blob(bb, {'type': 'image/png'});
        delete frame.dataParts;
        bb = null;
    });

    return apng;
}

// Exports
export {
    APNG,
    Frame,
    Player,
    isNotPNG,
    isNotAPNG
};
export default parseAPNG; 