const effectManager = {
    _playerDots: new Map<string, any[]>(),
    _playerBarriers: new Map<string, any[]>(),
    _playerStuns: new Map<string, any[]>(),
    _playerSlows: new Map<string, any[]>(),

    // --- DoTs / HoTs ---

    saveDots(username: string, dots: any[]) {
        if (!dots || dots.length === 0) {
            this._playerDots.delete(username);
            return;
        }
        this._playerDots.set(username, dots.map((d) => ({ ...d })));
    },

    loadDots(username: string): any[] {
        const dots = this._playerDots.get(username);
        if (!dots) return [];
        const now = Date.now();
        const active = dots.filter((d) => d.expiresAt > now);
        if (active.length === 0) {
            this._playerDots.delete(username);
        }
        return active;
    },

    // --- Barriers ---

    saveBarriers(username: string, barriers: any[]) {
        if (!barriers || barriers.length === 0) {
            this._playerBarriers.delete(username);
            return;
        }
        this._playerBarriers.set(username, barriers.map((b) => ({ ...b })));
    },

    loadBarriers(username: string): any[] {
        const barriers = this._playerBarriers.get(username);
        if (!barriers) return [];
        const now = Date.now();
        // expiresAt === 0 means permanent barriers; expiresAt > now for timed barriers
        const active = barriers.filter((b) => b.expiresAt > now || b.expiresAt === 0);
        if (active.length === 0) {
            this._playerBarriers.delete(username);
        }
        return active;
    },

    // --- Stuns ---

    saveStuns(username: string, stuns: any[]) {
        if (!stuns || stuns.length === 0) {
            this._playerStuns.delete(username);
            return;
        }
        this._playerStuns.set(username, stuns.map((s) => ({ ...s })));
    },

    loadStuns(username: string): any[] {
        const stuns = this._playerStuns.get(username);
        if (!stuns) return [];
        const now = Date.now();
        const active = stuns.filter((s) => s.expiresAt > now);
        if (active.length === 0) {
            this._playerStuns.delete(username);
        }
        return active;
    },

    // --- Slows ---

    saveSlows(username: string, slows: any[]) {
        if (!slows || slows.length === 0) {
            this._playerSlows.delete(username);
            return;
        }
        this._playerSlows.set(username, slows.map((s) => ({ ...s })));
    },

    loadSlows(username: string): any[] {
        const slows = this._playerSlows.get(username);
        if (!slows) return [];
        const now = Date.now();
        const active = slows.filter((s) => s.expiresAt > now);
        if (active.length === 0) {
            this._playerSlows.delete(username);
        }
        return active;
    },

    clearAll(username: string) {
        this._playerDots.delete(username);
        this._playerBarriers.delete(username);
        this._playerStuns.delete(username);
        this._playerSlows.delete(username);
    },
};

export default effectManager;
