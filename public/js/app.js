// LUICode Server UI JavaScript

document.addEventListener('DOMContentLoaded', () => {
    // Tab switching
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove active class from all buttons and panes
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));

            // Add active class to clicked button
            btn.classList.add('active');

            // Show corresponding pane
            const tabId = btn.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');
        });
    });

    // Provider API key saving
    document.getElementById('save-anthropic').addEventListener('click', () => {
        const key = document.getElementById('anthropic-key').value;
        if (key) {
            // In a real implementation, this would save to config
            alert('Anthropic API key saved!');
            document.getElementById('anthropic-key').value = '';
        } else {
            alert('Please enter an API key');
        }
    });

    document.getElementById('save-openai').addEventListener('click', () => {
        const key = document.getElementById('openai-key').value;
        if (key) {
            // In a real implementation, this would save to config
            alert('OpenAI API key saved!');
            document.getElementById('openai-key').value = '';
        } else {
            alert('Please enter an API key');
        }
    });

    // Ollama connection test
    document.getElementById('test-ollama').addEventListener('click', () => {
        const url = document.getElementById('ollama-url').value;
        // In a real implementation, this would test the connection
        alert(`Testing connection to ${url}...\n(This is a demo - actual implementation would test the connection)`);
    });

    // Model updates
    document.getElementById('update-planner').addEventListener('click', () => {
        const model = document.getElementById('planner-model').value;
        alert(`Planner model updated to: ${model}`);
    });

    document.getElementById('update-coder').addEventListener('click', () => {
        const model = document.getElementById('coder-model').value;
        alert(`Coder model updated to: ${model}`);
    });

    document.getElementById('update-reviewer').addEventListener('click', () => {
        const model = document.getElementById('reviewer-model').value;
        alert(`Reviewer model updated to: ${model}`);
    });

    document.getElementById('update-fallback').addEventListener('click', () => {
        const model = document.getElementById('fallback-model').value;
        alert(`Fallback model updated to: ${model}`);
    });

    // Messaging
    document.getElementById('send-message').addEventListener('click', () => {
        const input = document.getElementById('message-input');
        const message = input.value.trim();
        if (message) {
            addMessage(message, 'user');
            input.value = '';

            // Simulate agent response
            setTimeout(() => {
                addMessage('I understand. How can I assist you with your code?', 'agent');
            }, 1000);
        }
    });

    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('send-message').click();
        }
    });

    function addMessage(text, type) {
        const messageLog = document.getElementById('message-log');
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;
        messageDiv.textContent = text;
        messageLog.appendChild(messageDiv);
        messageLog.scrollTop = messageLog.scrollHeight;
    }

    // Load initial data
    loadSessionInfo();
    loadRecentFiles();
});

function loadSessionInfo() {
    // In a real implementation, this would fetch from the server API
    document.getElementById('workspace-path').textContent = '/current/workspace/path';
    document.getElementById('session-id').textContent = 'session-' + Math.random().toString(36).substr(2, 9);
    document.getElementById('current-task').textContent = 'Implementing new feature...';
}

function loadRecentFiles() {
    // In a real implementation, this would fetch from the server API
    const recentFiles = [
        { name: 'src/ui/commands.ts', size: '45 KB' },
        { name: 'src/server/server.ts', size: '12 KB' },
        { name: 'src/planner/Planner.ts', size: '67 KB' },
        { name: 'src/agent/executor.ts', size: '38 KB' },
        { name: 'public/index.html', size: '5 KB' }
    ];

    const fileList = document.getElementById('recent-files');
    recentFiles.forEach(file => {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'file-item';
        fileDiv.innerHTML = `
            <span class="file-name">${file.name}</span>
            <span class="file-size">${file.size}</span>
        `;
        fileList.appendChild(fileDiv);
    });
}