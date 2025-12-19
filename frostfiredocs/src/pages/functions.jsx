import { useState, useMemo } from 'react';
import '../styles/functions.css';

// Function data extracted from the HTML document
const functionsData = [
  { system: "audio", function: "get", params: "name: string", async: true, returnType: "", implementation: `{
  const audioList = await audio.list();
  return audioList.find((a: any) => a.name === name);
}` },
  { system: "audio", function: "list", params: "", async: true, returnType: "", implementation: `{
  return await assetCache.get("audio") as AudioData[];
}` },
  { system: "currency", function: "add", params: "username: string, amount: Currency", async: true, returnType: "Currency", implementation: `{
  const currentCurrency = await this.get(username);
  if (!currentCurrency) return { copper: 0, silver: 0, gold: 0 };

  if (currentCurrency.copper + amount.copper > max_copper) {
    const overflowToSilver = Math.floor((currentCurrency.copper + amount.copper) / (max_copper + 1));
    currentCurrency.silver += overflowToSilver;
    currentCurrency.copper = (currentCurrency.copper + amount.copper) % (max_copper + 1);
  }

  if (currentCurrency.silver + amount.silver > max_silver) {
    const overflowToGold = Math.floor((currentCurrency.silver + amount.silver) / (max_silver + 1));
    currentCurrency.gold += overflowToGold;
    currentCurrency.silver = currentCurrency.silver % (max_silver + 1);
  }

  if (currentCurrency.gold + amount.gold > max_gold) {
    currentCurrency.gold = max_gold;
  } else {
    currentCurrency.gold += amount.gold;
  }
  await this.set(username, currentCurrency);
  return currentCurrency;
}` },
  { system: "currency", function: "get", params: "username: string", async: true, returnType: "Currency", implementation: `{
  if (!username) return { copper: 0, silver: 0, gold: 0 };
  const response = await query("SELECT copper, silver, gold FROM currency WHERE username = ?", [username]) as Currency[];
  if (response.length === 0) return { copper: 0, silver: 0, gold: 0 };
  return response[0] as Currency;
}` },
  { system: "player", function: "login", params: "username: string, password: string", async: true, returnType: "", implementation: `{
  if (!username || !password) return;
  username = username.toLowerCase();
  const response = await query(
    "SELECT username, banned, token, password_hash FROM accounts WHERE username = ?",
    [username]
  ) as {
    username: string;
    banned: number;
    token: string;
    password_hash: string;
  }[];
  if (response.length === 0 || response[0].banned === 1) {
    return;
  }

  const isValid = await verify(password, response[0].password_hash);
  if (!isValid) {
    return;
  }

  const token = response[0].token || (await player.setToken(username));
  await query(
    "UPDATE accounts SET last_login = CURRENT_TIMESTAMP WHERE username = ?",
    [username]
  );
  return token;
}` },
  { system: "inventory", function: "get", params: "name: string", async: true, returnType: "", implementation: `{
  if (!name) return [];
  
  const _items = await query("SELECT * FROM inventory WHERE username = ?", [name]) as any[];
  
  if (!_items || _items.length === 0) return [];

  _items.filter((item: any) => {
    delete item.username;
    delete item.id;
  });

  const details = await Promise.all(
    _items.map(async (item: any) => {
      const itemDetails = (items as any).find((i: any) => i.name === item.item);
      if (itemDetails) {
        return {
          ...item,
          ...itemDetails,
        };
      } else {
        return {
          ...item,
          name: item.item,
          quality: "unknown",
          description: "unknown",
          icon: null,
        };
      }
    })
  );
  return details;
}` }
];

export default function Functions() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSystem, setSelectedSystem] = useState('all');
  const [selectedFunction, setSelectedFunction] = useState(null);

  // Get unique systems
  const systems = useMemo(() => {
    const systemSet = new Set(functionsData.map(f => f.system));
    return ['all', ...Array.from(systemSet).sort()];
  }, []);

  // Filter functions
  const filteredFunctions = useMemo(() => {
    return functionsData.filter(func => {
      const matchesSearch = 
        func.function.toLowerCase().includes(searchQuery.toLowerCase()) ||
        func.system.toLowerCase().includes(searchQuery.toLowerCase()) ||
        func.params.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesSystem = selectedSystem === 'all' || func.system === selectedSystem;
      
      return matchesSearch && matchesSystem;
    });
  }, [searchQuery, selectedSystem]);

  // Group by system
  const groupedFunctions = useMemo(() => {
    const grouped = {};
    filteredFunctions.forEach(func => {
      if (!grouped[func.system]) {
        grouped[func.system] = [];
      }
      grouped[func.system].push(func);
    });
    return grouped;
  }, [filteredFunctions]);

  const copyCode = (code) => {
    navigator.clipboard.writeText(code);
  };

  return (
    <div className="functions-container">
      <div className="functions-header">
        <h1>
          <span className="header-icon">⚡</span>
          API Functions
        </h1>
        <p className="header-subtitle">
          Complete reference for all system functions
        </p>
      </div>

      <div className="functions-controls">
        <div className="search-box">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search functions... (e.g., player.login, currency.add)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="filter-box">
          <label>System:</label>
          <select 
            value={selectedSystem} 
            onChange={(e) => setSelectedSystem(e.target.value)}
            className="system-select"
          >
            {systems.map(sys => (
              <option key={sys} value={sys}>
                {sys === 'all' ? 'All Systems' : sys}
              </option>
            ))}
          </select>
        </div>

        <div className="results-count">
          {filteredFunctions.length} function{filteredFunctions.length !== 1 ? 's' : ''}
        </div>
      </div>

      <div className="functions-content">
        {Object.entries(groupedFunctions).map(([system, functions]) => (
          <div key={system} className="system-group">
            <h2 className="system-name">
              <span className="system-icon">📦</span>
              {system}
            </h2>
            
            <div className="functions-grid">
              {functions.map((func, idx) => (
                <div 
                  key={`${func.system}-${func.function}-${idx}`}
                  className="function-card"
                  onClick={() => setSelectedFunction(func)}
                >
                  <div className="function-header">
                    <span className="function-name">
                      {func.system}.<span className="method-name">{func.function}</span>
                    </span>
                    {func.async && <span className="async-badge">async</span>}
                  </div>
                  
                  <div className="function-signature">
                    ({func.params})
                    {func.returnType && <span className="return-type">: {func.returnType}</span>}
                  </div>
                  
                  <div className="function-hint">👁️ Click to view code</div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {filteredFunctions.length === 0 && (
          <div className="no-results">
            <span className="no-results-icon">🔍</span>
            <p>No functions found</p>
            <p className="no-results-hint">Try adjusting your search or filter</p>
          </div>
        )}
      </div>

      {selectedFunction && (
        <div className="modal-overlay" onClick={() => setSelectedFunction(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                {selectedFunction.async && <span className="async-badge">async</span>}
                <span className="function-full-name">
                  {selectedFunction.system}.{selectedFunction.function}
                </span>
                <span className="function-params">
                  ({selectedFunction.params})
                  {selectedFunction.returnType && `: ${selectedFunction.returnType}`}
                </span>
              </div>
              <button className="modal-close" onClick={() => setSelectedFunction(null)}>
                ×
              </button>
            </div>
            
            <div className="modal-body">
              <pre className="code-block">
                <code>{selectedFunction.implementation}</code>
              </pre>
              
              <button 
                className="copy-button"
                onClick={() => copyCode(selectedFunction.implementation)}
              >
                📋 Copy Code
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}