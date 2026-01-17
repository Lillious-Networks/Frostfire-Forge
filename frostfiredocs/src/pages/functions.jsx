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
      <div className="functions-header bertui-animated bertui-fadeInDown">
        <h1 className="bertui-animated bertui-fadeIn">
          <span className="header-icon bertui-animated bertui-tada bertui-delay-1s">
            ⚡
          </span>
          API Functions
        </h1>
        <p className="header-subtitle bertui-animated bertui-fadeIn bertui-delay-2s">
          Complete reference for all system functions
        </p>
      </div>

      <div className="functions-controls bertui-animated bertui-fadeInUp bertui-delay-1s">
        <div className="search-box">
          <span className="search-icon bertui-animated bertui-pulse bertui-infinite bertui-slow">🔍</span>
          <input
            type="text"
            placeholder="Search functions... (e.g., player.login, currency.add)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input bertui-animated bertui-fadeInLeft"
          />
        </div>

        <div className="filter-box bertui-animated bertui-fadeInUp bertui-delay-2s">
          <label>System:</label>
          <select 
            value={selectedSystem} 
            onChange={(e) => setSelectedSystem(e.target.value)}
            className="system-select bertui-animated bertui-fadeInRight"
          >
            {systems.map(sys => (
              <option key={sys} value={sys} className="bertui-animated bertui-fadeInUp">
                {sys === 'all' ? 'All Systems' : sys}
              </option>
            ))}
          </select>
        </div>

        <div className="results-count bertui-animated bertui-fadeInUp bertui-delay-3s">
          {filteredFunctions.length} function{filteredFunctions.length !== 1 ? 's' : ''}
        </div>
      </div>

      <div className="functions-content">
        {Object.entries(groupedFunctions).map(([system, functions], systemIndex) => (
          <div key={system} className="system-group bertui-animated bertui-fadeInUp" style={{ animationDelay: `${systemIndex * 0.2}s` }}>
            <h2 className="system-name bertui-animated bertui-fadeIn">
              <span className="system-icon bertui-animated bertui-wobble">📦</span>
              {system}
            </h2>
            
            <div className="functions-grid">
              {functions.map((func, idx) => (
                <div 
                  key={`${func.system}-${func.function}-${idx}`}
                  className="function-card bertui-animated bertui-fadeInUp bertui-slow"
                  style={{ animationDelay: `${idx * 0.1}s` }}
                  onClick={() => setSelectedFunction(func)}
                >
                  <div className="function-header">
                    <span className="function-name bertui-animated bertui-fadeInLeft">
                      {func.system}.<span className="method-name">{func.function}</span>
                    </span>
                    {func.async && <span className="async-badge bertui-animated bertui-pulse bertui-infinite bertui-slow">async</span>}
                  </div>
                  
                  <div className="function-signature bertui-animated bertui-fadeIn bertui-delay-1s">
                    ({func.params})
                    {func.returnType && <span className="return-type">: {func.returnType}</span>}
                  </div>
                  
                  <div className="function-hint bertui-animated bertui-pulse bertui-infinite bertui-slow">
                    👁️ Click to view code
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {filteredFunctions.length === 0 && (
          <div className="no-results bertui-animated bertui-fadeInUp bertui-delay-1s">
            <span className="no-results-icon bertui-animated bertui-tada">🔍</span>
            <p className="bertui-animated bertui-fadeIn bertui-delay-2s">No functions found</p>
            <p className="no-results-hint bertui-animated bertui-fadeIn bertui-delay-3s">Try adjusting your search or filter</p>
          </div>
        )}
      </div>

      {selectedFunction && (
        <div className="modal-overlay bertui-animated bertui-fadeIn" onClick={() => setSelectedFunction(null)}>
          <div className="modal-content bertui-animated bertui-zoomIn" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                {selectedFunction.async && <span className="async-badge bertui-animated bertui-pulse bertui-infinite bertui-slow">async</span>}
                <span className="function-full-name bertui-animated bertui-fadeInLeft">
                  {selectedFunction.system}.{selectedFunction.function}
                </span>
                <span className="function-params bertui-animated bertui-fadeInRight">
                  ({selectedFunction.params})
                  {selectedFunction.returnType && `: ${selectedFunction.returnType}`}
                </span>
              </div>
              <button 
                className="modal-close bertui-animated bertui-pulse bertui-infinite bertui-slow" 
                onClick={() => setSelectedFunction(null)}
              >
                ×
              </button>
            </div>
            
            <div className="modal-body">
              <pre className="code-block bertui-animated bertui-fadeIn bertui-delay-1s">
                <code>{selectedFunction.implementation}</code>
              </pre>
              
              <button 
                className="copy-button bertui-animated bertui-pulse bertui-infinite bertui-slow"
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