// Create access to window object
declare global {
    interface Window { ServerUtils: any; }
}

// add our object to window such that it can be used.
window.ServerUtils = window.ServerUtils || {};

// Just example file for loading more assets from assetloader.ts

const Client = {
    PONG: {
        type: "PING",
        data: null,
    }
};

const Server = {

};


window.ServerUtils = { Packets: {Client, Server} };