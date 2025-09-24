import assetCache from "../services/assetCache";

const audio = {
    list: async () => {
        return await assetCache.get("audio") as AudioData[];
    },
    get: async (name: string) => {
        const audioList = await audio.list();
        return audioList.find((a: any) => a.name === name);
    }
}

export default audio;