import fs from 'fs';
import path from 'path';
import log from '../modules/logger';

interface FunctionInfo {
    name: string;
    params: string;
    async: boolean;
    returnType?: string;
    implementation?: string;
}

interface SystemDoc {
    name: string;
    functions: FunctionInfo[];
}

const systemsDir = path.join(import.meta.dir, '..', 'systems');
const outputHtml = path.join(import.meta.dir, '..', 'webserver', 'www', 'public', 'docs.html');

// Remove inline comments from parameter strings and normalize whitespace
function stripInlineComments(params: string): string {
    return params
        .replace(/\/\/.*$/gm, '')  // Remove // comments
        .replace(/\/\*.*?\*\//g, '')  // Remove /* */ comments
        .replace(/\s+/g, ' ')  // Normalize all whitespace to single spaces
        .trim();
}

// Extract function body by matching braces
function extractFunctionBody(content: string, startIndex: number): string {
    let braceCount = 0;
    let inString = false;
    let stringChar = '';

    let body = '';
    let started = false;

    for (let i = startIndex; i < content.length; i++) {
        const char = content[i];
        const prevChar = i > 0 ? content[i - 1] : '';

        // Handle string literals
        if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
            if (!inString) {
                inString = true;
                stringChar = char;
            } else if (char === stringChar) {
                inString = false;
                stringChar = '';
            }
        }

        if (!inString) {
            if (char === '{') {
                if (!started) started = true;
                braceCount++;
            } else if (char === '}') {
                braceCount--;
                if (braceCount === 0 && started) {
                    body += char;
                    break;
                }
            }
        }

        if (started) {
            body += char;
        }
    }

    return body;
}

// Parse a TypeScript file to extract function information
function parseFunctions(content: string): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const seenFunctions = new Set<string>();

    // Pattern 1: Arrow functions in object literals
    // Match: functionName: async (params) => { ... } or functionName: (params): ReturnType => { ... }
    const arrowFunctionPattern = /(\w+):\s*(async\s+)?(?:function\s*)?\(([^)]*)\)\s*(?::\s*Promise<([^>]+)>|:\s*([^\{=]+?))?\s*(?:=>|{)/g;

    let match;
    while ((match = arrowFunctionPattern.exec(content)) !== null) {
        const [, name, asyncKeyword, params, promiseReturn, directReturn] = match;

        // Skip if we've already seen this function
        if (seenFunctions.has(name)) continue;
        seenFunctions.add(name);

        // Clean up return type
        let returnType = promiseReturn || directReturn?.trim();
        if (returnType) {
            returnType = returnType.replace(/\s*=>\s*$/, '').trim();
            // Remove trailing characters that might be captured
            returnType = returnType.replace(/[{=]$/, '').trim();
        }

        // Extract implementation
        const implementation = extractFunctionBody(content, match.index);

        // Clean parameters
        const cleanParams = stripInlineComments(params);

        functions.push({
            name,
            params: cleanParams,
            async: !!asyncKeyword || !!promiseReturn,
            returnType,
            implementation
        });
    }

    // Pattern 2: Object method shorthand (most common in your codebase)
    // Match: async methodName(params): ReturnType { ... } inside object literals
    const methodShorthandPattern = /^\s*(async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*Promise<([^>]+)>|:\s*([^\{]+))?\s*{/gm;

    while ((match = methodShorthandPattern.exec(content)) !== null) {
        const [, asyncKeyword, name, params, promiseReturn, directReturn] = match;

        // Skip control flow keywords
        if (['if', 'while', 'for', 'switch', 'catch', 'try'].includes(name)) continue;

        if (seenFunctions.has(name)) continue;
        seenFunctions.add(name);

        const returnType = promiseReturn || directReturn?.trim();

        // Extract implementation
        const implementation = extractFunctionBody(content, match.index);

        // Clean parameters
        const cleanParams = stripInlineComments(params);

        functions.push({
            name,
            params: cleanParams,
            async: !!asyncKeyword || !!promiseReturn,
            returnType,
            implementation,
        });
    }

    // Pattern 3: Regular function declarations
    // Match: async function functionName(params): ReturnType { ... } or function functionName(params) { ... }
    const regularFunctionPattern = /(async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*Promise<([^>]+)>|:\s*([^\{]+))?\s*{/g;

    while ((match = regularFunctionPattern.exec(content)) !== null) {
        const [, asyncKeyword, name, params, promiseReturn, directReturn] = match;

        if (seenFunctions.has(name)) continue;
        seenFunctions.add(name);

        const returnType = promiseReturn || directReturn?.trim();

        // Extract implementation
        const implementation = extractFunctionBody(content, match.index);

        // Clean parameters
        const cleanParams = stripInlineComments(params);

        functions.push({
            name,
            params: cleanParams,
            async: !!asyncKeyword || !!promiseReturn,
            returnType,
            implementation
        });
    }

    return functions;
}

// Extract the export name from the file
function extractExportName(content: string, fileName: string): string {
    // Match: export default exportName;
    const exportMatch = content.match(/export\s+default\s+(\w+);?/);
    if (exportMatch) {
        return exportMatch[1];
    }

    // Fallback to filename without extension
    return fileName.replace('.ts', '');
}

// Generate documentation for all system files
async function generateDocs() {
    const startTime = performance.now();

    try {
        // Read all TypeScript files in the systems directory
        const files = fs.readdirSync(systemsDir).filter(f => f.endsWith('.ts'));

        if (files.length === 0) {
            throw new Error('No TypeScript files found in systems directory');
        }

        const systemDocs: SystemDoc[] = [];

        // Process each file
        for (const file of files) {
            const filePath = path.join(systemsDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const exportName = extractExportName(content, file);
            const functions = parseFunctions(content);

            if (functions.length > 0) {
                systemDocs.push({
                    name: exportName,
                    functions: functions.sort((a, b) => a.name.localeCompare(b.name))
                });
            }
        }

        // Sort systems alphabetically
        systemDocs.sort((a, b) => a.name.localeCompare(b.name));

        // Generate HTML
        const html = generateHTML(systemDocs);

        // Write HTML file
        if (fs.existsSync(outputHtml)) {
            fs.unlinkSync(outputHtml);
        }
        fs.writeFileSync(outputHtml, html);

        const elapsed = (performance.now() - startTime).toFixed(2);
        log.success(`Documentation generated in ${elapsed}ms`);
        log.info(`Found ${systemDocs.length} systems with ${systemDocs.reduce((sum, s) => sum + s.functions.length, 0)} functions`);

    } catch (error: any) {
        log.error(`Failed to generate documentation: ${error.message}`);
        throw error;
    }
}

// Generate the HTML document
function generateHTML(systems: SystemDoc[]): string {
    // Build search index as JSON
    const searchIndex = systems.flatMap(system =>
        system.functions.map(func => ({
            system: system.name,
            function: func.name,
            fullName: `${system.name}.${func.name}`,
            params: func.params,
            async: func.async,
            returnType: func.returnType || ''
        }))
    );

    const functionsHTML = systems.map(system => `
        <div class="system-section">
            <h2 class="system-title" id="system-${system.name}">${system.name}</h2>
            <div class="functions-container">
                ${system.functions.map(func => {
                    // Escape implementation for HTML attribute
                    const escapedImpl = (func.implementation || '')
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#039;');

                    return `
                    <div class="function-item clickable"
                         id="func-${system.name}-${func.name}"
                         data-search="${system.name}.${func.name}"
                         data-implementation="${escapedImpl}"
                         data-function="${system.name}.${func.name}"
                         data-async="${func.async}"
                         data-params="${func.params}"
                         data-return="${func.returnType || ''}">
                        <div class="function-signature">
                            ${func.async ? '<span class="async-badge">async</span>' : ''}
                            <span class="function-name">${system.name}.<span class="method-name">${func.name}</span></span>
                            <span class="params">(${formatParams(func.params)})</span>
                            ${func.returnType ? `<span class="return-type">: ${func.returnType}</span>` : ''}
                            <span class="view-code-hint">👁️ Click to view code</span>
                        </div>
                    </div>
                `;
                }).join('')}
            </div>
        </div>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/ico" href="./img/icons/favicon.ico">
    <link rel="stylesheet" href="./css/docs.css">
    <title>Frostfire Forge - API Documentation</title>
</head>
<body>
    <div class="home-button" onclick="location.href='/'"></div>
    <div class="container">
        <div class="header">
            <h1>Frostfire Forge</h1>
            <p>API Documentation - System Functions Reference</p>
            <div class="search-container">
                <input type="text" class="search-input" id="searchInput" placeholder="Search functions... (e.g., player.login, currency.add)" autocomplete="off">
                <span class="search-icon">🔍</span>
                <div class="search-results" id="searchResults"></div>
            </div>
        </div>
        ${functionsHTML}
        <div class="stats">
            <p>Total Systems: ${systems.length} | Total Functions: ${systems.reduce((sum, s) => sum + s.functions.length, 0)}</p>
            <p>Generated on ${new Date().toLocaleString()}</p>
        </div>
    </div>

    <!-- Code Modal -->
    <div class="modal" id="codeModal">
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title" id="modalTitle"></div>
                <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="code-block" id="codeBlock"></div>
                <button class="copy-button" id="copyButton" onclick="copyCode()">Copy Code</button>
            </div>
        </div>
    </div>

    <script>
        // Search index
        const searchIndex = ${JSON.stringify(searchIndex)};

        // Modal Elements and Functions (defined first so they're available to other handlers)
        const modal = document.getElementById('codeModal');
        const modalTitle = document.getElementById('modalTitle');
        const codeBlock = document.getElementById('codeBlock');
        const copyButton = document.getElementById('copyButton');
        let currentCode = '';

        // Decode HTML entities
        function decodeHtml(html) {
            const txt = document.createElement('textarea');
            txt.innerHTML = html;
            return txt.value;
        }

        function openModal(functionName, implementation, isAsync, params, returnType) {
            // Clean any inline comments from params and normalize whitespace
            const cleanParams = params
                .replace(/\\/\\/.*$/gm, '')  // Remove // comments
                .replace(/\\/\\*.*?\\*\\//g, '')  // Remove /* */ comments
                .replace(/\\s+/g, ' ')  // Normalize whitespace
                .trim();

            // Build function signature
            const signature = \`\${isAsync === 'true' ? 'async ' : ''}\${functionName}(\${cleanParams})\${returnType ? ': ' + returnType : ''}\`;
            modalTitle.textContent = signature;

            // Decode HTML entities from the data attribute
            const decodedCode = decodeHtml(implementation);

            // Store current code for copying
            currentCode = decodedCode;

            // Escape HTML entities for display, then apply syntax highlighting
            const escapedCode = decodedCode
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            // Apply basic syntax highlighting
            const highlighted = syntaxHighlight(escapedCode);
            codeBlock.innerHTML = '<pre>' + highlighted + '</pre>';

            // Show modal
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        function closeModal() {
            modal.classList.remove('active');
            document.body.style.overflow = '';
            copyButton.textContent = 'Copy Code';
            copyButton.classList.remove('copied');
        }

        function copyCode() {
            navigator.clipboard.writeText(currentCode).then(() => {
                copyButton.textContent = '✓ Copied!';
                copyButton.classList.add('copied');
                setTimeout(() => {
                    copyButton.textContent = 'Copy Code';
                    copyButton.classList.remove('copied');
                }, 2000);
            });
        }

        // Basic syntax highlighting - works on HTML-escaped code
        function syntaxHighlight(code) {
            return code
                // Keywords
                .replace(/\\b(async|await|const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|export|default|from|as|typeof|instanceof|Promise)\\b/g, '<span style="color: #569cd6">$1</span>')
                // Strings (handle quotes)
                .replace(/(&quot;)((?:(?!&quot;).)*?)(&quot;)/g, '<span style="color: #ce9178">$1$2$3</span>')
                .replace(/(&#039;)((?:(?!&#039;).)*?)(&#039;)/g, '<span style="color: #ce9178">$1$2$3</span>')
                .replace(/(\`)((?:(?!\`).)*?)(\`)/g, '<span style="color: #ce9178">$1$2$3</span>')
                // Comments
                .replace(/(\\/\\/.*$)/gm, '<span style="color: #6a9955">$1</span>')
                .replace(/(\\/\\*[\\s\\S]*?\\*\\/)/g, '<span style="color: #6a9955">$1</span>')
                // Numbers
                .replace(/\\b(\\d+)\\b/g, '<span style="color: #b5cea8">$1</span>')
                // this, null, undefined, true, false
                .replace(/\\b(this|null|undefined|true|false)\\b/g, '<span style="color: #569cd6">$1</span>')
                // Function calls (before the opening paren)
                .replace(/\\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\\s*\\()/g, '<span style="color: #dcdcaa">$1</span>');
        }

        // Search Elements
        const searchInput = document.getElementById('searchInput');
        const searchResults = document.getElementById('searchResults');
        let selectedIndex = -1;

        // Search functionality
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim().toLowerCase();

            if (query.length === 0) {
                searchResults.classList.remove('active');
                searchResults.innerHTML = '';
                selectedIndex = -1;
                return;
            }

            // Find matching functions
            const matches = searchIndex.filter(item => {
                const fullName = item.fullName.toLowerCase();
                const funcName = item.function.toLowerCase();
                const systemName = item.system.toLowerCase();

                return fullName.includes(query) ||
                       funcName.includes(query) ||
                       systemName.includes(query);
            }).slice(0, 10); // Limit to 10 results

            if (matches.length === 0) {
                searchResults.innerHTML = '<div class="search-no-results">No functions found</div>';
                searchResults.classList.add('active');
                return;
            }

            // Render results
            searchResults.innerHTML = matches.map((item, index) => \`
                <div class="search-result-item" data-index="\${index}" data-id="func-\${item.system}-\${item.function}">
                    <div class="search-result-name">
                        <span class="search-result-method">\${item.fullName}</span>
                        \${item.async ? '<span class="async-badge" style="margin-left: 8px;">async</span>' : ''}
                    </div>
                    <div class="search-result-params">(\${item.params})\${item.returnType ? ': ' + item.returnType : ''}</div>
                </div>
            \`).join('');

            searchResults.classList.add('active');
            selectedIndex = -1;
        });

        // Keyboard navigation
        searchInput.addEventListener('keydown', (e) => {
            const items = searchResults.querySelectorAll('.search-result-item');

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
                updateSelection(items);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, -1);
                updateSelection(items);
            } else if (e.key === 'Enter' && selectedIndex >= 0) {
                e.preventDefault();
                items[selectedIndex]?.click();
            } else if (e.key === 'Escape') {
                searchResults.classList.remove('active');
                selectedIndex = -1;
            }
        });

        function updateSelection(items) {
            items.forEach((item, index) => {
                if (index === selectedIndex) {
                    item.classList.add('selected');
                    item.scrollIntoView({ block: 'nearest' });
                } else {
                    item.classList.remove('selected');
                }
            });
        }

        // Handle result click
        searchResults.addEventListener('click', (e) => {
            const item = e.target.closest('.search-result-item');
            if (item) {
                const targetId = item.getAttribute('data-id');
                const targetElement = document.getElementById(targetId);

                if (targetElement) {
                    // Expand the parent section
                    const parentSection = targetElement.closest('.system-section');
                    if (parentSection) {
                        parentSection.classList.remove('collapsed');
                    }

                    // Smooth scroll to element
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

                    // Highlight the element briefly
                    targetElement.style.transform = 'scale(1.02)';
                    targetElement.style.transition = 'transform 0.3s ease';

                    setTimeout(() => {
                        targetElement.style.transform = '';
                    }, 600);

                    // Close search results
                    searchResults.classList.remove('active');
                    searchInput.value = '';
                    selectedIndex = -1;

                    // Auto-open the code modal after a brief delay for scroll animation
                    setTimeout(() => {
                        const implementation = targetElement.getAttribute('data-implementation');
                        const functionName = targetElement.getAttribute('data-function');
                        const isAsync = targetElement.getAttribute('data-async');
                        const params = targetElement.getAttribute('data-params');
                        const returnType = targetElement.getAttribute('data-return');

                        if (implementation && functionName) {
                            openModal(functionName, implementation, isAsync, params, returnType);
                        }
                    }, 400);
                }
            }
        });

        // Close search results when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-container')) {
                searchResults.classList.remove('active');
                selectedIndex = -1;
            }
        });

        // Focus search with Ctrl+K or Cmd+K
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                searchInput.focus();
            }
        });

        // Add click handlers to all function items
        document.querySelectorAll('.function-item.clickable').forEach(item => {
            item.addEventListener('click', () => {
                const implementation = item.getAttribute('data-implementation');
                const functionName = item.getAttribute('data-function');
                const isAsync = item.getAttribute('data-async');
                const params = item.getAttribute('data-params');
                const returnType = item.getAttribute('data-return');

                openModal(functionName, implementation, isAsync, params, returnType);
            });
        });

        // Close modal on outside click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        // Close modal on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('active')) {
                closeModal();
            }
        });

        // Collapse/Expand functionality
        document.querySelectorAll('.system-title').forEach(title => {
            title.addEventListener('click', (e) => {
                // Don't toggle if clicking on a link or other interactive element
                if (e.target.tagName === 'A') return;

                const section = title.closest('.system-section');
                section.classList.toggle('collapsed');
            });
        });

        // Set all sections to collapsed by default
        document.querySelectorAll('.system-section').forEach(section => {
            section.classList.add('collapsed');
        });
    </script>
</body>
</html>`;
}

// Helper function to format parameters
function formatParams(params: string): string {
    if (!params) return '';

    // Split by comma but respect nested types
    const parts = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < params.length; i++) {
        const char = params[i];
        if (char === '<' || char === '{' || char === '[') depth++;
        if (char === '>' || char === '}' || char === ']') depth--;

        if (char === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    if (current) parts.push(current.trim());

    return parts.map(p => {
        // Highlight parameter names and types
        const [name, type] = p.split(':').map(s => s.trim());
        if (type) {
            return `<span style="color: #9cdcfe">${name}</span>: <span style="color: #4ec9b0">${type}</span>`;
        }
        return `<span style="color: #9cdcfe">${name}</span>`;
    }).join(', ');
}

// Run the documentation generator
generateDocs();
