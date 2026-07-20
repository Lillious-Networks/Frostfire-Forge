const cooldownManager = {
    _spellCooldowns: new Map<string, Map<number, number>>(),
    _spellLockouts: new Map<string, number>(),

    hasCooldown(username: string, spellId: number): boolean {
        const spells = this._spellCooldowns.get(username);
        if (!spells) return false;
        const endTime = spells.get(spellId) || 0;
        if (endTime <= performance.now()) {
            spells.delete(spellId);
            return false;
        }
        return true;
    },

    setCooldown(username: string, spellId: number, endTime: number): void {
        if (!this._spellCooldowns.has(username)) {
            this._spellCooldowns.set(username, new Map());
        }
        this._spellCooldowns.get(username)!.set(spellId, endTime);
    },

    deleteCooldown(username: string, spellId: number): void {
        this._spellCooldowns.get(username)?.delete(spellId);
    },

    getActiveCooldowns(username: string): { [spellId: number]: number } {
        const result: { [spellId: number]: number } = {};
        const spells = this._spellCooldowns.get(username);
        if (!spells) return result;
        const now = performance.now();
        spells.forEach((endTime, spellId) => {
            if (endTime > now) {
                result[spellId] = endTime;
            }
        });
        return result;
    },

    getLockout(username: string): number {
        const lockout = this._spellLockouts.get(username) || 0;
        if (lockout <= performance.now()) {
            this._spellLockouts.delete(username);
            return 0;
        }
        return lockout;
    },

    setLockout(username: string, endTime: number): void {
        this._spellLockouts.set(username, endTime);
    },
};

export default cooldownManager;
