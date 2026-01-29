const app = {
    token: localStorage.getItem('opendbs_token'),
    user: JSON.parse(localStorage.getItem('opendbs_user') || '{}'),
    currentDb: null,
    currentRack: null,
    theme: localStorage.getItem('opendbs_theme') || 'light',
    editor: null,

    // --- Permissions ---
    can(action, dbName = null) {
        if (!this.user || !this.user.role) return false;
        if (this.user.role === 'admin') return true;

        // If no DB context (e.g. creating DB), only admin can usually
        if (!dbName) return false;

        // Check specific DB permissions
        const perms = this.user.permissions || {};
        const dbPerms = perms[dbName] || [];
        // Map UI actions to backend permission strings if needed
        // Backend uses: 'read', 'write', 'delete'
        // 'create' usually falls under 'write' for Racks/Docs?
        // Let's assume:
        // 'create' -> needs 'write'
        // 'edit' -> needs 'write'
        // 'delete' -> needs 'delete'

        const required = action === 'create' || action === 'edit' ? 'write' : action;
        return dbPerms.includes(required);
    },

    // --- Theme ---
    initTheme() {
        document.documentElement.setAttribute('data-theme', this.theme);
        this.updateThemeIcon();
    },

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        localStorage.setItem('opendbs_theme', this.theme);
        document.documentElement.setAttribute('data-theme', this.theme);
        this.updateThemeIcon();
        this.updateEditorTheme();
    },

    updateThemeIcon() {
        const icon = document.getElementById('themeIcon');
        if (icon) {
            icon.className = this.theme === 'light' ? 'bi bi-moon-stars-fill' : 'bi bi-sun-fill';
        }
    },

    // --- SweetAlert2 Helpers ---
    async showAlert(title, text, icon = 'info') {
        return await Swal.fire({
            title,
            text,
            icon,
            confirmButtonText: 'OK',
            background: this.theme === 'dark' ? '#1a1d29' : '#fff',
            color: this.theme === 'dark' ? '#e0e0e0' : '#333',
            confirmButtonColor: '#0d6efd'
        });
    },

    async showSuccess(title, text = '') {
        return await Swal.fire({
            title,
            text,
            icon: 'success',
            confirmButtonText: 'OK',
            background: this.theme === 'dark' ? '#1a1d29' : '#fff',
            color: this.theme === 'dark' ? '#e0e0e0' : '#333',
            confirmButtonColor: '#198754',
            timer: 2000,
            timerProgressBar: true
        });
    },

    async showError(title, text = '') {
        return await Swal.fire({
            title,
            text,
            icon: 'error',
            confirmButtonText: 'OK',
            background: this.theme === 'dark' ? '#1a1d29' : '#fff',
            color: this.theme === 'dark' ? '#e0e0e0' : '#333',
            confirmButtonColor: '#dc3545'
        });
    },

    async showWarning(title, text = '') {
        return await Swal.fire({
            title,
            text,
            icon: 'warning',
            confirmButtonText: 'OK',
            background: this.theme === 'dark' ? '#1a1d29' : '#fff',
            color: this.theme === 'dark' ? '#e0e0e0' : '#333',
            confirmButtonColor: '#ffc107'
        });
    },

    async confirm(title, text = '', confirmText = 'Yes', cancelText = 'No') {
        const result = await Swal.fire({
            title,
            text,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: confirmText,
            cancelButtonText: cancelText,
            background: this.theme === 'dark' ? '#1a1d29' : '#fff',
            color: this.theme === 'dark' ? '#e0e0e0' : '#333',
            confirmButtonColor: '#0d6efd',
            cancelButtonColor: '#6c757d',
            reverseButtons: true
        });
        return result.isConfirmed;
    },

    async confirmDanger(title, text = '', confirmText = 'Delete') {
        const result = await Swal.fire({
            title,
            text,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: confirmText,
            cancelButtonText: 'Cancel',
            background: this.theme === 'dark' ? '#1a1d29' : '#fff',
            color: this.theme === 'dark' ? '#e0e0e0' : '#333',
            confirmButtonColor: '#dc3545',
            cancelButtonColor: '#6c757d',
            reverseButtons: true
        });
        return result.isConfirmed;
    },

    // --- Auth ---
    async login(username, password) {
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();

            if (res.ok) {
                localStorage.setItem('opendbs_token', data.token);
                // Store full user object from server which includes role/permissions
                localStorage.setItem('opendbs_user', JSON.stringify(data.user));
                window.location.href = 'index.html';
            } else {
                this.showErrorLegacy(data.error || 'Login failed');
            }
        } catch (e) {
            this.showErrorLegacy(e.message);
        }
    },

    checkAuth() {
        return !!this.token;
    },

    logout() {
        localStorage.removeItem('opendbs_token');
        localStorage.removeItem('opendbs_user');
        window.location.href = 'login.html';
    },

    async fetchVersion() {
        try {
            const res = await fetch('/health');
            if (res.ok) {
                const data = await res.json();
                const v = document.getElementById('appVersion');
                if (v && data.version) v.textContent = `v${data.version}`;
            }
        } catch (e) {
            console.error('Failed to fetch version', e);
        }
    },

    // --- Backups ---
    async showBackups() {
        const main = document.getElementById('mainContent');
        main.innerHTML = '<div class="text-center mt-5"><div class="spinner-border text-primary"></div></div>';

        try {
            const res = await this.fetch('/api/backup/list');
            const data = res && res.ok ? await res.json() : { backups: [] };
            const backups = data.backups || [];

            let html = `
                <div class="d-flex justify-content-between align-items-center mb-4">
                    <h2>Backups</h2>
                    <button class="btn btn-primary" onclick="app.createBackup()">
                        <i class="bi bi-plus-lg me-2"></i>Create Backup
                    </button>
                </div>
                
                <div class="card shadow-sm border-0">
                    <div class="card-body p-0">
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0">
                                <thead class="bg-light">
                                    <tr>
                                        <th class="ps-4">Name</th>
                                        <th>Size</th>
                                        <th>Date</th>
                                        <th class="text-end pe-4">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
            `;

            if (backups.length === 0) {
                html += `<tr><td colspan="4" class="text-center py-5 text-muted">No backups found</td></tr>`;
            } else {
                backups.forEach(b => {
                    const date = new Date(b.created).toLocaleString();
                    const size = (b.size / 1024 / 1024).toFixed(2) + ' MB';
                    html += `
                        <tr>
                            <td class="ps-4 fw-medium text-primary">${b.name}</td>
                            <td>${size}</td>
                            <td>${date}</td>
                            <td class="text-end pe-4">
                                <button class="btn btn-sm btn-outline-primary me-1" onclick="app.downloadBackup('${b.name}')">
                                    <i class="bi bi-download"></i>
                                </button>
                                ${this.user.role === 'admin' ? `
                                <button class="btn btn-sm btn-outline-warning" onclick="app.restoreBackup('${b.name}')">
                                    <i class="bi bi-arrow-counterclockwise me-1"></i> Restore
                                </button>
                                ` : ''}
                            </td>
                        </tr>
                    `;
                });
            }

            html += `</tbody></table></div></div></div>`;
            main.innerHTML = html;
        } catch (e) {
            this.showError('Error', 'Failed to load backups');
        }
    },

    async createBackup() {
        if (!await this.confirm('Create Backup?', 'Are you sure you want to create a new backup?')) return;

        try {
            const res = await this.fetch('/api/backup/create', { method: 'POST' });
            if (res.ok) {
                await this.showSuccess('Backup Created', 'Backup has been created successfully');
                this.showBackups();
            } else {
                const err = await res.json();
                this.showError('Error', err.error);
            }
        } catch (e) {
            this.showError('Error', 'Failed to create backup');
        }
    },

    async restoreBackup(name) {
        if (!await this.confirmDanger('Restore Backup?', `Are you sure you want to restore "${name}"? Current data will be overwritten!`, 'Restore')) return;

        try {
            const res = await this.fetch('/api/backup/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ backupName: name })
            });
            if (res.ok) {
                await this.showSuccess('Restored', 'Database restored successfully');
                this.showDashboard();
            } else {
                const err = await res.json();
                this.showError('Error', err.error);
            }
        } catch (e) {
            this.showError('Error', 'Failed to restore backup');
        }
    },

    async downloadBackup(name) {
        try {
            const res = await this.fetch(`/api/backup/${name}/download`);
            if (res.ok) {
                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(url);
            } else {
                const err = await res.json();
                this.showError('Error', err.error || 'Download failed');
            }
        } catch (e) {
            this.showError('Error', 'Download failed');
        }
    },

    // --- Settings ---
    async showSettings() {
        const main = document.getElementById('mainContent');
        main.innerHTML = '<div class="text-center mt-5"><div class="spinner-border text-primary"></div></div>';

        try {
            const res = await this.fetch('/api/settings/env');
            if (res.status === 403) {
                main.innerHTML = `<div class="alert alert-warning m-4">Settings are disabled in configuration (SHOW_ENVONWEB=false).</div>`;
                return;
            }
            const data = await res.json();
            const env = data.env || {};

            let html = `
                <div class="d-flex justify-content-between align-items-center mb-4">
                    <h2>Settings</h2>
                    <button class="btn btn-primary" onclick="app.saveSettings()">
                        <i class="bi bi-save me-2"></i>Save Changes
                    </button>
                </div>
                <div class="card shadow-sm border-0">
                    <div class="card-header bg-transparent py-3">
                        <h5 class="mb-0">Environment Variables (.env)</h5>
                    </div>
                    <div class="card-body">
                        <form id="settingsForm">
            `;

            for (const [key, val] of Object.entries(env)) {
                html += `
                    <div class="mb-3 row">
                        <label class="col-sm-3 col-form-label fw-medium text-muted">${key}</label>
                        <div class="col-sm-9">
                            <input type="text" class="form-control" name="${key}" value="${val}">
                        </div>
                    </div>
                `;
            }

            html += `
                        </form>
                        <div class="alert alert-info mt-3">
                            <i class="bi bi-info-circle me-2"></i>
                            Changes will only affect the .env file. You may need to restart the server manually for detailed configuration changes to take effect.
                        </div>
                    </div>
                </div>
            `;

            main.innerHTML = html;
        } catch (e) {
            this.showError('Error', 'Failed to load settings');
        }
    },

    async saveSettings() {
        const form = document.getElementById('settingsForm');
        const formData = new FormData(form);
        const updates = {};
        formData.forEach((value, key) => {
            updates[key] = value;
        });

        if (!await this.confirm('Save Settings?', 'Are you sure? Incorrect settings may break the server.')) return;

        try {
            const res = await this.fetch('/api/settings/env', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });

            if (res.ok) {
                await this.showSuccess('Saved', 'Settings updated successfully.');
            } else {
                const err = await res.json();
                this.showError('Error', err.error);
            }
        } catch (e) {
            this.showError('Error', 'Failed to save settings');
        }
    },

    async init() {
        this.fetchVersion();
        this.initTheme();
        const userEl = document.getElementById('currentUser');
        if (userEl) userEl.textContent = this.user.username || 'User';

        // Hide admin link if not admin
        if (this.user.role !== 'admin') {
            const adminMenu = document.getElementById('adminMenu');
            if (adminMenu) adminMenu.style.display = 'none';
        } else {
            const adminMenu = document.getElementById('adminMenu');
            if (adminMenu && !document.getElementById('navLinkUsers')) {
                const li = document.createElement('div');
                li.className = 'nav-item';
                li.innerHTML = `<a href="#" id="navLinkUsers" class="nav-link" onclick="app.showUsers()"><i class="bi bi-people me-2"></i> Users</a>`;
                adminMenu.after(li);
            }
        }

        await this.loadDatabases();
        this.showDashboard();
    },

    async fetch(url, options = {}) {
        options.headers = options.headers || {};
        options.headers['Authorization'] = `Bearer ${this.token}`;

        const res = await fetch(url, options);
        if (res.status === 401) {
            this.logout();
            return null;
        }
        return res;
    },

    // --- Editor ---
    setupEditor() {
        if (!this.editor && window.CodeMirror) {
            const textarea = document.getElementById('editorData');
            if (textarea) {
                this.editor = CodeMirror.fromTextArea(textarea, {
                    mode: "application/json",
                    theme: this.theme === 'dark' ? 'dracula' : 'default',
                    lineNumbers: true,
                    lint: true,
                    gutters: ["CodeMirror-lint-markers"],
                    matchBrackets: true,
                    autoCloseBrackets: true,
                    tabSize: 2
                });

                // Refresh on tab switch to fix rendering issues
                const jsonTab = document.getElementById('json-tab');
                if (jsonTab) {
                    jsonTab.addEventListener('shown.bs.tab', () => {
                        this.editor.refresh();
                    });
                }
            }
        }
    },

    updateEditorTheme() {
        if (this.editor) {
            this.editor.setOption('theme', this.theme === 'dark' ? 'dracula' : 'default');
        }
    },

    // --- Views ---
    async loadDatabases() {
        try {
            const res = await this.fetch('/api/databases');
            if (!res) return;
            const data = await res.json();

            const list = document.getElementById('dbList');
            if (!list) return;
            list.innerHTML = '';

            // Filter out system database
            const dbs = (data.databases || []).filter(db => db !== '_opendbs_system');

            if (dbs.length === 0) {
                list.innerHTML = '<div class="text-center text-muted small mt-2">No databases</div>';
                return;
            }

            dbs.forEach(db => {
                const div = document.createElement('div');
                div.className = 'nav-item';
                div.innerHTML = `
                    <a href="#" class="nav-link" onclick="app.showDatabase('${db}')">
                        <i class="bi bi-hdd-stack me-2"></i>${db}
                    </a>
                `;
                list.appendChild(div);
            });
        } catch (e) {
            console.error('Failed to load databases', e);
        }
    },

    async showUsers() {
        if (this.user.role !== 'admin') return;

        const main = document.getElementById('mainContent');
        main.innerHTML = `
            <div class="d-flex justify-content-center pt-5">
                <div class="spinner-border text-primary"></div>
            </div>
        `;

        try {
            const res = await this.fetch('/api/auth/users');
            const data = res && res.ok ? await res.json() : { users: [] };

            let rows = '';
            data.users.forEach(u => {
                rows += `
                    <tr>
                        <td>${u.username}</td>
                        <td><span class="badge ${u.role === 'admin' ? 'bg-danger' : 'bg-primary'}">${u.role}</span></td>
                        <td class="small text-muted">${new Date(u.createdAt).toLocaleString()}</td>
                        <td class="text-end">
                            ${u.username !== 'admin' && u.id !== this.user.id ? `
                            <button class="btn btn-sm btn-icon btn-ghost-secondary me-1" onclick="app.openEditUserModal('${u.id}')" title="Edit User">
                                <i class="bi bi-pencil"></i>
                            </button>
                            <button class="btn btn-sm btn-icon btn-ghost-danger" onclick="app.deleteUser('${u.id}')" title="Delete User">
                                <i class="bi bi-trash"></i>
                            </button>` : ''}
                        </td>
                    </tr>
                 `;
            });

            main.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-4">
                    <h2 class="fw-bold mb-0">System Users</h2>
                    <div class="d-flex gap-2">
                        <button class="btn btn-primary" onclick="app.openCreateUserModal()">
                            <i class="bi bi-person-plus me-2"></i>Create User
                        </button>
                        <button class="btn btn-outline-secondary" onclick="app.toggleTheme()">
                            <i id="themeIcon" class="bi bi-moon-stars-fill"></i>
                        </button>
                    </div>
                </div>

                <div class="card">
                    <div class="table-responsive">
                        <table class="table table-hover mb-0 align-middle">
                            <thead class="bg-card border-bottom border-secondary">
                                <tr>
                                    <th class="ps-3">Username</th>
                                    <th>Role</th>
                                    <th>Created</th>
                                    <th class="text-end pe-3">Actions</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
            `;
            this.updateThemeIcon();
        } catch (e) {
            main.innerHTML = `<div class="alert alert-danger">Error loading users: ${e.message}</div>`;
        }
    },

    async deleteUser(userId) {
        if (!await this.confirmDanger('Delete User?', 'This action cannot be undone.')) return;

        const res = await this.fetch(`/api/auth/users/${userId}`, { method: 'DELETE' });
        if (res.ok) {
            await this.showSuccess('Deleted!', 'User has been deleted successfully.');
            this.showUsers();
        } else {
            const err = await res.json();
            await this.showError('Error', err.error || 'Failed to delete user');
        }
    },

    async openCreateUserModal() {
        console.log('openCreateUserModal called');

        // Show modal first
        const modal = new bootstrap.Modal(document.getElementById('createUserModal'));
        modal.show();

        // Reset form
        document.getElementById('newUsername').value = '';
        document.getElementById('newUserPassword').value = '';
        document.getElementById('newUserRole').value = 'user';

        // Show permissions section by default (since default role is 'user')
        this.togglePermissionsSection();

        // Load databases for permissions
        try {
            console.log('Fetching databases...');
            const res = await this.fetch('/api/databases');
            console.log('Response:', res);

            if (!res || !res.ok) {
                console.error('Failed to fetch databases');
                document.getElementById('databasePermissionsList').innerHTML =
                    '<div class="alert alert-warning mb-0">Failed to load databases</div>';
                return;
            }

            const data = await res.json();
            console.log('Database data:', data);

            const permissionsList = document.getElementById('databasePermissionsList');
            console.log('Permissions list element:', permissionsList);

            const dbs = (data.databases || []).filter(db => db !== '_opendbs_system');
            console.log('Filtered databases:', dbs);

            if (dbs.length === 0) {
                permissionsList.innerHTML = '<div class="text-muted small">No databases available. Create a database first.</div>';
                return;
            }

            let html = '';
            dbs.forEach(db => {
                html += `
                    <div class="card mb-2" style="background: var(--bg-card); border: 1px solid var(--border-color);">
                        <div class="card-body py-2 px-3">
                            <div class="form-check mb-2">
                                <input class="form-check-input db-checkbox" type="checkbox" id="db_${db}" data-db="${db}">
                                <label class="form-check-label fw-bold" for="db_${db}">
                                    <i class="bi bi-database me-1"></i>${db}
                                </label>
                            </div>
                            <div class="ms-4 db-permissions" data-db="${db}" style="display:none;">
                                <div class="form-check form-check-inline">
                                    <input class="form-check-input perm-read" type="checkbox" id="perm_${db}_read" data-db="${db}" data-perm="read">
                                    <label class="form-check-label small" for="perm_${db}_read">
                                        <i class="bi bi-eye"></i> Read
                                    </label>
                                </div>
                                <div class="form-check form-check-inline">
                                    <input class="form-check-input perm-write" type="checkbox" id="perm_${db}_write" data-db="${db}" data-perm="write">
                                    <label class="form-check-label small" for="perm_${db}_write">
                                        <i class="bi bi-pencil"></i> Write
                                    </label>
                                </div>
                                <div class="form-check form-check-inline">
                                    <input class="form-check-input perm-delete" type="checkbox" id="perm_${db}_delete" data-db="${db}" data-perm="delete">
                                    <label class="form-check-label small" for="perm_${db}_delete">
                                        <i class="bi bi-trash"></i> Delete
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            });

            console.log('Setting innerHTML with', dbs.length, 'databases');
            permissionsList.innerHTML = html;

            // Add event listeners for checkboxes
            document.querySelectorAll('.db-checkbox').forEach(checkbox => {
                checkbox.addEventListener('change', function () {
                    const db = this.getAttribute('data-db');
                    const permSection = document.querySelector(`.db-permissions[data-db="${db}"]`);
                    if (this.checked) {
                        permSection.style.display = 'block';
                        // Auto-check read permission
                        document.getElementById(`perm_${db}_read`).checked = true;
                    } else {
                        permSection.style.display = 'none';
                        // Uncheck all permissions
                        document.getElementById(`perm_${db}_read`).checked = false;
                        document.getElementById(`perm_${db}_write`).checked = false;
                        document.getElementById(`perm_${db}_delete`).checked = false;
                    }
                });
            });

            console.log('Database loading complete');
        } catch (e) {
            console.error('Failed to load databases:', e);
            document.getElementById('databasePermissionsList').innerHTML =
                `<div class="alert alert-danger mb-0">Error: ${e.message}</div>`;
        }
    },

    togglePermissionsSection() {
        const role = document.getElementById('newUserRole').value;
        const section = document.getElementById('permissionsSection');
        section.style.display = role === 'user' ? 'block' : 'none';
    },

    async createUser() {
        const username = document.getElementById('newUsername').value.trim();
        const password = document.getElementById('newUserPassword').value;
        const role = document.getElementById('newUserRole').value;

        if (!username) {
            await this.showWarning('Missing Field', 'Username is required');
            return;
        }

        if (!password || password.length < 6) {
            await this.showWarning('Invalid Password', 'Password must be at least 6 characters');
            return;
        }

        // Build permissions object for non-admin users
        let permissions = {};
        if (role === 'user') {
            const dbCheckboxes = document.querySelectorAll('.db-checkbox:checked');

            dbCheckboxes.forEach(checkbox => {
                const db = checkbox.getAttribute('data-db');
                const perms = [];

                // Check which permissions are selected
                if (document.getElementById(`perm_${db}_read`).checked) perms.push('read');
                if (document.getElementById(`perm_${db}_write`).checked) perms.push('write');
                if (document.getElementById(`perm_${db}_delete`).checked) perms.push('delete');

                if (perms.length > 0) {
                    permissions[db] = perms;
                }
            });
        }

        try {
            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    password,
                    role,
                    permissions: role === 'user' ? permissions : undefined
                })
            });

            if (res.ok) {
                const data = await res.json();
                bootstrap.Modal.getInstance(document.getElementById('createUserModal')).hide();

                // Build permissions summary
                let permSummary = '';
                if (role === 'user' && Object.keys(permissions).length > 0) {
                    permSummary = '\n\nPermissions:\n';
                    for (const [db, perms] of Object.entries(permissions)) {
                        permSummary += `  ${db}: ${perms.join(', ')}\n`;
                    }
                }

                // Show API key to admin
                await Swal.fire({
                    title: 'User Created Successfully!',
                    html: `<div style="text-align: left;">
                        <p><strong>Username:</strong> ${username}</p>
                        <p><strong>Role:</strong> ${role}</p>
                        ${permSummary ? `<p><strong>Permissions:</strong><br><pre style="font-size: 0.9em;">${permSummary}</pre></p>` : ''}
                        <hr>
                        <p><strong>API Key:</strong></p>
                        <code style="background: #f5f5f5; padding: 8px; display: block; word-break: break-all; color: #333;">${data.user.apiKey}</code>
                        <div class="alert alert-warning mt-3" style="font-size: 0.9em;">
                            ⚠️ <strong>Important:</strong> Save this API key - it won't be shown again!
                        </div>
                    </div>`,
                    icon: 'success',
                    confirmButtonText: 'I\'ve Saved It',
                    background: this.theme === 'dark' ? '#1a1d29' : '#fff',
                    color: this.theme === 'dark' ? '#e0e0e0' : '#333',
                    confirmButtonColor: '#198754',
                    width: '600px'
                });

                // Clear form
                document.getElementById('newUsername').value = '';
                document.getElementById('newUserPassword').value = '';
                document.getElementById('newUserRole').value = 'user';

                // Refresh user list
                this.showUsers();
            } else {
                const err = await res.json();
                await this.showError('Error', err.error || 'Failed to create user');
            }
        } catch (e) {
            await this.showError('Error', 'Error creating user: ' + e.message);
        }
    },

    async openEditUserModal(userId) {
        try {
            // Fetch user details
            const res = await this.fetch(`/api/auth/users`);
            const data = res && res.ok ? await res.json() : { users: [] };
            const user = data.users.find(u => u.id === userId);

            if (!user) {
                await this.showError('Error', 'User not found');
                return;
            }

            // Populate form
            document.getElementById('editUserId').value = user.id;
            document.getElementById('editUsername').value = user.username;
            document.getElementById('editUserPassword').value = '';
            document.getElementById('editUserRole').value = user.role;

            // Show/hide permissions section
            this.toggleEditPermissionsSection();

            // Load databases for permissions
            const dbRes = await this.fetch('/api/databases');
            if (!dbRes || !dbRes.ok) {
                document.getElementById('editDatabasePermissionsList').innerHTML =
                    '<div class="alert alert-warning mb-0">Failed to load databases</div>';
            } else {
                const dbData = await dbRes.json();
                const permissionsList = document.getElementById('editDatabasePermissionsList');
                const dbs = (dbData.databases || []).filter(db => db !== '_opendbs_system');

                if (dbs.length === 0) {
                    permissionsList.innerHTML = '<div class="text-muted small">No databases available.</div>';
                } else {
                    let html = '';
                    dbs.forEach(db => {
                        const userPerms = (user.permissions && user.permissions[db]) || [];
                        const hasAccess = userPerms.length > 0;

                        html += `
                            <div class="card mb-2" style="background: var(--bg-card); border: 1px solid var(--border-color);">
                                <div class="card-body py-2 px-3">
                                    <div class="form-check mb-2">
                                        <input class="form-check-input db-checkbox-edit" type="checkbox" id="edit_db_${db}" data-db="${db}" ${hasAccess ? 'checked' : ''}>
                                        <label class="form-check-label fw-bold" for="edit_db_${db}">
                                            <i class="bi bi-database me-1"></i>${db}
                                        </label>
                                    </div>
                                    <div class="ms-4 db-permissions-edit" data-db="${db}" style="${hasAccess ? '' : 'display:none;'}">
                                        <div class="form-check form-check-inline">
                                            <input class="form-check-input perm-read-edit" type="checkbox" id="edit_perm_${db}_read" data-db="${db}" data-perm="read" ${userPerms.includes('read') ? 'checked' : ''}>
                                            <label class="form-check-label small" for="edit_perm_${db}_read">
                                                <i class="bi bi-eye"></i> Read
                                            </label>
                                        </div>
                                        <div class="form-check form-check-inline">
                                            <input class="form-check-input perm-write-edit" type="checkbox" id="edit_perm_${db}_write" data-db="${db}" data-perm="write" ${userPerms.includes('write') ? 'checked' : ''}>
                                            <label class="form-check-label small" for="edit_perm_${db}_write">
                                                <i class="bi bi-pencil"></i> Write
                                            </label>
                                        </div>
                                        <div class="form-check form-check-inline">
                                            <input class="form-check-input perm-delete-edit" type="checkbox" id="edit_perm_${db}_delete" data-db="${db}" data-perm="delete" ${userPerms.includes('delete') ? 'checked' : ''}>
                                            <label class="form-check-label small" for="edit_perm_${db}_delete">
                                                <i class="bi bi-trash"></i> Delete
                                            </label>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `;
                    });

                    permissionsList.innerHTML = html;

                    // Add event listeners
                    document.querySelectorAll('.db-checkbox-edit').forEach(checkbox => {
                        checkbox.addEventListener('change', function () {
                            const db = this.getAttribute('data-db');
                            const permSection = document.querySelector(`.db-permissions-edit[data-db="${db}"]`);
                            if (this.checked) {
                                permSection.style.display = 'block';
                                document.getElementById(`edit_perm_${db}_read`).checked = true;
                            } else {
                                permSection.style.display = 'none';
                                document.getElementById(`edit_perm_${db}_read`).checked = false;
                                document.getElementById(`edit_perm_${db}_write`).checked = false;
                                document.getElementById(`edit_perm_${db}_delete`).checked = false;
                            }
                        });
                    });
                }
            }

            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('editUserModal'));
            modal.show();
        } catch (e) {
            await this.showError('Error', 'Failed to load user: ' + e.message);
        }
    },

    toggleEditPermissionsSection() {
        const role = document.getElementById('editUserRole').value;
        const section = document.getElementById('editPermissionsSection');
        section.style.display = role === 'user' ? 'block' : 'none';
    },

    async updateUser() {
        const userId = document.getElementById('editUserId').value;
        const password = document.getElementById('editUserPassword').value;
        const role = document.getElementById('editUserRole').value;

        // Build update object
        const updateData = { role };

        // Only include password if it's provided
        if (password && password.length >= 6) {
            updateData.password = password;
        } else if (password && password.length > 0 && password.length < 6) {
            await this.showWarning('Invalid Password', 'Password must be at least 6 characters');
            return;
        }

        // Build permissions object for non-admin users
        if (role === 'user') {
            const permissions = {};
            const dbCheckboxes = document.querySelectorAll('.db-checkbox-edit:checked');

            dbCheckboxes.forEach(checkbox => {
                const db = checkbox.getAttribute('data-db');
                const perms = [];

                if (document.getElementById(`edit_perm_${db}_read`).checked) perms.push('read');
                if (document.getElementById(`edit_perm_${db}_write`).checked) perms.push('write');
                if (document.getElementById(`edit_perm_${db}_delete`).checked) perms.push('delete');

                if (perms.length > 0) {
                    permissions[db] = perms;
                }
            });

            updateData.permissions = permissions;
        }

        try {
            const res = await this.fetch(`/api/auth/users/${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData)
            });

            if (res.ok) {
                bootstrap.Modal.getInstance(document.getElementById('editUserModal')).hide();
                await this.showSuccess('Updated!', 'User has been updated successfully');
                this.showUsers();
            } else {
                const err = await res.json();
                await this.showError('Error', err.error || 'Failed to update user');
            }
        } catch (e) {
            await this.showError('Error', 'Error updating user: ' + e.message);
        }
    },

    async showDashboard() {
        this.currentDb = null;
        this.currentRack = null;
        const main = document.getElementById('mainContent');

        // Show loading state
        main.innerHTML = `
            <div class="d-flex justify-content-center align-items-center" style="height: 50vh;">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
            </div>
        `;

        try {
            // 1. Fetch all databases
            const res = await this.fetch('/api/databases');
            const data = res && res.ok ? await res.json() : { databases: [] };
            const allDbs = (data.databases || []).filter(db => db !== '_opendbs_system');

            // 2. Fetch stats for accessible databases in parallel
            const dbPromises = allDbs.map(async (db) => {
                // Client-side permission check
                if (!this.can('read', db)) return null;

                try {
                    const statsRes = await this.fetch(`/api/databases/${db}/stats`);
                    const stats = statsRes && statsRes.ok ? await statsRes.json() : { racks: [] };
                    return {
                        name: db,
                        racks: stats.racks || []
                    };
                } catch (e) {
                    console.error(`Failed to load stats for ${db}:`, e);
                    return { name: db, racks: [], error: true };
                }
            });

            const accessibleDbs = (await Promise.all(dbPromises)).filter(db => db !== null);

            // Fetch Health Status
            let healthStatus = 'Unknown';
            let healthIcon = 'bi-question-circle';
            let healthBadgeClass = 'text-warning';

            try {
                const hRes = await fetch('/health');
                if (hRes.ok) {
                    healthStatus = 'System Operational';
                    healthIcon = 'bi-check-circle-fill';
                    healthBadgeClass = 'text-success';
                } else {
                    healthStatus = 'System Issues';
                    healthIcon = 'bi-exclamation-triangle-fill';
                    healthBadgeClass = 'text-danger';
                }
            } catch (e) {
                healthStatus = 'System Offline';
                healthIcon = 'bi-wifi-off';
                healthBadgeClass = 'text-danger';
            }

            // 3. Render Dashboard
            const showCreateDb = this.user.role === 'admin';

            let dashboardHtml = `
                <div class="d-flex justify-content-between align-items-center mb-4">
                    <h2 class="fw-bold mb-0">Dashboard</h2>
                    <div class="d-flex gap-2">
                        ${showCreateDb ? `
                        <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#createDbModal">
                            <i class="bi bi-plus-lg me-2"></i>New Database
                        </button>` : ''}
                        <button class="btn btn-outline-secondary" onclick="app.toggleTheme()">
                            <i id="themeIcon" class="bi bi-moon-stars-fill"></i>
                        </button>
                    </div>
                </div>
            `;

            // System Status Card (User Friendly)
            dashboardHtml += `
                 <div class="row g-4 mb-5">
                    <div class="col-md-12">
                         <div class="card bg-primary text-white border-0 shadow-sm" style="background: linear-gradient(45deg, var(--primary), #4a90e2);">
                            <div class="card-body p-4">
                                <div class="d-flex align-items-center justify-content-between">
                                    <div>
                                        <h5 class="mb-2">Welcome back, ${this.user.username}!</h5>
                                        <p class="mb-2 opacity-75">You have access to ${accessibleDbs.length} databases.</p>
                                        <span class="badge bg-white ${healthBadgeClass} shadow-sm py-2 px-3">
                                            <i class="bi ${healthIcon} me-1"></i> ${healthStatus}
                                        </span>
                                    </div>
                                    <i class="bi bi-database-check display-4 opacity-50"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            if (accessibleDbs.length === 0) {
                dashboardHtml += `
                    <div class="text-center py-5">
                        <div class="mb-3 text-muted"><i class="bi bi-folder2-open display-1"></i></div>
                        <h4>No Databases Found</h4>
                        <p class="text-muted">You don't have access to any databases yet.</p>
                        ${showCreateDb ? `<button class="btn btn-primary mt-2" data-bs-toggle="modal" data-bs-target="#createDbModal">Create Your First Database</button>` : ''}
                    </div>
                `;
            } else {
                dashboardHtml += '<div class="row g-4 masonry-grid">';

                accessibleDbs.forEach(db => {
                    let racksList = '';

                    if (db.racks.length > 0) {
                        racksList = `<div class="list-group list-group-flush">`;
                        db.racks.forEach(rack => {
                            racksList += `
                                <a href="#" onclick="app.showRack('${db.name}', '${rack.name}')" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center px-0 py-2 bg-transparent border-0">
                                    <div class="d-flex align-items-center">
                                        <i class="bi ${rack.type === 'sql' ? 'bi-table text-info' : 'bi-file-code text-warning'} me-2"></i>
                                        <span>${rack.name}</span>
                                    </div>
                                    <span class="badge bg-secondary bg-opacity-10 text-secondary rounded-pill">${rack.count || 0}</span>
                                </a>
                            `;
                        });
                        racksList += `</div>`;
                    } else {
                        racksList = `<div class="text-muted small py-3 fst-italic">No racks created yet</div>`;
                    }

                    dashboardHtml += `
                        <div class="col-md-6 col-lg-4">
                            <div class="card h-100 border-0 shadow-sm hover-elevate" style="background: var(--bg-card); transition: transform 0.2s;">
                                <div class="card-header bg-transparent border-0 pt-4 px-4 pb-0 d-flex justify-content-between align-items-center" onclick="app.showDatabase('${db.name}')" style="cursor: pointer;">
                                    <h5 class="card-title fw-bold mb-0 text-primary">
                                        <i class="bi bi-database me-2"></i>${db.name}
                                    </h5>
                                    <i class="bi bi-chevron-right text-muted small"></i>
                                </div>
                                <div class="card-body px-4 pb-4">
                                    <hr class="my-2 opacity-10">
                                    ${racksList}
                                </div>
                                <div class="card-footer bg-transparent border-0 px-4 pb-3 pt-0">
                                    ${this.can('write', db.name) ? `
                                    <button class="btn btn-sm btn-light w-100 text-muted" onclick="app.showDatabase('${db.name}')">
                                        Manage Database
                                    </button>` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                });

                dashboardHtml += '</div>';
            }

            main.innerHTML = dashboardHtml;
            this.updateThemeIcon();

        } catch (e) {
            console.error('Dashboard Error:', e);
            main.innerHTML = `
                <div class="alert alert-danger m-4">
                    <h4>Error loading dashboard</h4>
                    <p>${e.message}</p>
                    <button class="btn btn-outline-danger" onclick="app.showDashboard()">Try Again</button>
                </div>
            `;
        }
    },

    async showDatabase(dbName) {
        this.currentDb = dbName;
        const main = document.getElementById('mainContent');

        const res = await this.fetch(`/api/databases/${dbName}/stats`);
        const stats = res && res.ok ? await res.json() : { racks: [] };

        const canCreateRack = this.can('write', dbName);
        const canDeleteDb = this.can('delete', dbName); // Or admin only? API says delete perm.

        let racksHtml = '';
        if (stats.racks && stats.racks.length > 0) {
            stats.racks.forEach(rack => {
                racksHtml += `
                    <div class="col-md-6 col-xl-4">
                        <div class="card h-100 hover-card" onclick="app.showRack('${dbName}', '${rack.name}')" style="cursor:pointer">
                            <div class="card-body">
                                <div class="d-flex justify-content-between align-items-start mb-2">
                                    <h5 class="card-title mb-0">
                                        <i class="bi ${rack.type === 'sql' ? 'bi-table' : 'bi-file-code'} me-2 ${rack.type === 'sql' ? 'text-info' : 'text-warning'}"></i>
                                        ${rack.name}
                                    </h5>
                                    <span class="badge bg-secondary">${rack.type}</span>
                                </div>
                                <p class="text-muted small mb-0">${rack.count || 0} documents</p>
                            </div>
                        </div>
                    </div>
                `;
            });
        } else {
            racksHtml = '<div class="col-12"><div class="alert alert-secondary mb-0">No racks found in this database.</div></div>';
        }

        main.innerHTML = `
            <nav aria-label="breadcrumb">
                <ol class="breadcrumb">
                    <li class="breadcrumb-item"><a href="#" onclick="app.showDashboard()">Home</a></li>
                    <li class="breadcrumb-item active">${dbName}</li>
                </ol>
            </nav>
            
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2 class="fw-bold">${dbName}</h2>
                <div class="d-flex gap-2">
                    ${canCreateRack ? `
                    <button class="btn btn-outline-primary btn-sm" onclick="app.createRackModal('${dbName}')">
                        <i class="bi bi-plus-lg"></i> New Rack
                    </button>` : ''}
                     ${canDeleteDb ? `
                    <button class="btn btn-outline-danger btn-sm" onclick="app.deleteDatabase('${dbName}')">
                        <i class="bi bi-trash"></i> Delete DB
                    </button>` : ''}
                    <button class="btn btn-outline-secondary btn-sm" onclick="app.toggleTheme()">
                        <i id="themeIcon" class="bi bi-moon-stars-fill"></i>
                    </button>
                </div>
            </div>

            <div class="row g-3">
                ${racksHtml}
            </div>
        `;
        this.updateThemeIcon();
    },

    createRackModal(dbName) {
        document.getElementById('newRackDbName').value = dbName;
        document.getElementById('newRackName').value = '';
        const modal = new bootstrap.Modal(document.getElementById('createRackModal'));
        modal.show();
    },

    async createRack() {
        const dbName = document.getElementById('newRackDbName').value;
        const rackName = document.getElementById('newRackName').value;
        const rackType = document.getElementById('newRackType').value;

        if (!rackName) return;

        try {
            const res = await this.fetch(`/api/databases/${dbName}/racks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: rackName, type: rackType })
            });

            if (res.ok) {
                bootstrap.Modal.getInstance(document.getElementById('createRackModal')).hide();
                this.showDatabase(dbName);
            } else {
                const err = await res.json();
                await this.showError('Error', err.error || 'Failed to create rack');
            }
        } catch (e) {
            await this.showError('Error', 'Failed to create rack');
        }
    },

    async showRack(dbName, rackName, query = {}) {
        this.currentRack = rackName;
        const main = document.getElementById('mainContent');

        main.innerHTML = `
            <div class="d-flex justify-content-center pt-5">
                <div class="spinner-border text-primary"></div>
            </div>
        `;

        try {
            const res = await this.fetch(`/api/databases/${dbName}/racks/${rackName}/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: query, limit: 50 })
            });

            const rawData = res && res.ok ? await res.json() : {};
            // FIX: Access .results property. Fallback to empty array.
            const docs = rawData.results || [];

            const canRead = this.can('read', dbName);
            const canWrite = this.can('write', dbName);
            const canDelete = this.can('delete', dbName);

            // Fetch indexes
            let indexesHtml = '';
            let indexesData = [];
            try {
                const indexRes = await this.fetch(`/api/databases/${dbName}/racks/${rackName}/indexes`);
                if (indexRes && indexRes.ok) {
                    const indexData = await indexRes.json();
                    indexesData = indexData.indexes || [];

                    if (indexesData.length > 0) {
                        let indexRows = '';
                        indexesData.forEach(idx => {
                            indexRows += `
                                <tr>
                                    <td class="ps-3">
                                        <i class="bi bi-lightning-charge text-warning me-2"></i>
                                        <span class="font-monospace">${idx}</span>
                                    </td>
                                    <td class="small text-muted">Indexed Field</td>
                                    <td class="text-end pe-3">
                                        <button class="btn btn-sm btn-icon btn-ghost-info me-1" onclick="app.viewIndexedData('${dbName}', '${rackName}', '${idx}')" title="View Indexed Data">
                                            <i class="bi bi-eye"></i>
                                        </button>
                                        ${canDelete ? `
                                        <button class="btn btn-sm btn-icon btn-ghost-danger" onclick="app.deleteIndex('${dbName}', '${rackName}', '${idx}')" title="Delete Index">
                                            <i class="bi bi-trash"></i>
                                        </button>` : ''}
                                    </td>
                                </tr>
                            `;
                        });

                        indexesHtml = `
                            <div class="card mb-3">
                                <div class="card-header d-flex justify-content-between align-items-center" style="cursor: pointer;" onclick="document.getElementById('indexesTableBody').classList.toggle('d-none')">
                                    <strong>
                                        <i class="bi bi-lightning-charge-fill text-warning me-2"></i>
                                        Indexes (${indexesData.length})
                                    </strong>
                                    <i class="bi bi-chevron-down"></i>
                                </div>
                                <div id="indexesTableBody">
                                    <div class="table-responsive">
                                        <table class="table table-hover mb-0 align-middle">
                                            <thead class="bg-card border-bottom border-secondary">
                                                <tr>
                                                    <th class="ps-3">Field Name</th>
                                                    <th>Type</th>
                                                    <th class="text-end pe-3">Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${indexRows}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        `;
                    }
                }
            } catch (e) {
                console.error('Failed to load indexes', e);
            }

            let rows = '';
            docs.forEach(doc => {
                const dataStr = JSON.stringify(doc.data || doc).substring(0, 80) + '...';
                rows += `
                    <tr>
                        <td class="font-monospace text-primary" style="width:200px">${doc.id}</td>
                        <td class="small text-muted text-truncate" style="max-width:300px">${dataStr}</td>
                        <td class="text-end">
                             ${canRead && !canWrite ? `
                            <button class="btn btn-sm btn-icon btn-ghost-info" onclick='app.viewDocument(${JSON.stringify(doc)})' title="View (Read-Only)">
                                <i class="bi bi-eye"></i>
                            </button>` : ''}
                             ${canWrite ? `
                            <button class="btn btn-sm btn-icon btn-ghost-secondary" onclick='app.editDocument(${JSON.stringify(doc)})' title="Edit">
                                <i class="bi bi-pencil"></i>
                            </button>` : ''}
                            ${canDelete ? `
                            <button class="btn btn-sm btn-icon btn-ghost-danger" onclick="app.deleteDocument('${doc.id}')" title="Delete">
                                <i class="bi bi-trash"></i>
                            </button>` : ''}
                        </td>
                    </tr>
                `;
            });

            const searchQueryStr = JSON.stringify(query) === '{}' ? '' : (query.id || JSON.stringify(query));

            main.innerHTML = `
                <nav aria-label="breadcrumb">
                    <ol class="breadcrumb">
                        <li class="breadcrumb-item"><a href="#" onclick="app.showDashboard()">Home</a></li>
                        <li class="breadcrumb-item"><a href="#" onclick="app.showDatabase('${dbName}')">${dbName}</a></li>
                        <li class="breadcrumb-item active">${rackName}</li>
                    </ol>
                </nav>

                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h4 class="mb-0">${rackName}</h4>
                    <div class="d-flex align-items-center">
                         <div class="input-group input-group-sm me-2" style="width:250px;">
                            <input type="text" class="form-control bg-card text-main border-secondary" id="searchRackInput" placeholder="Search ID or JSON..." value='${searchQueryStr}'>
                            <button class="btn btn-outline-secondary" onclick="app.triggerSearch()">
                                <i class="bi bi-search"></i>
                            </button>
                         </div>
                         ${canWrite ? `<button class="btn btn-primary btn-sm me-2" onclick="app.createDocument()">Add Document</button>` : ''}
                         ${canWrite ? `<button class="btn btn-outline-info btn-sm me-2" onclick="app.createIndexModal()" title="Create Index"><i class="bi bi-lightning-charge"></i></button>` : ''}
                         <button class="btn btn-outline-secondary btn-sm" onclick="app.toggleTheme()">
                            <i id="themeIcon" class="bi bi-moon-stars-fill"></i>
                         </button>
                    </div>
                </div>

                ${indexesHtml}

                <div class="card">
                    <div class="table-responsive">
                        <table class="table table-hover mb-0 align-middle">
                            <thead class="bg-card border-bottom border-secondary">
                                <tr>
                                    <th class="ps-3">ID</th>
                                    <th>Data Preview</th>
                                    <th class="text-end pe-3">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows || '<tr><td colspan="3" class="text-center py-4 text-muted">No documents found</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
            this.updateThemeIcon();

            const input = document.getElementById('searchRackInput');
            if (input) {
                input.addEventListener('keypress', function (e) {
                    if (e.key === 'Enter') app.triggerSearch();
                });
            }

        } catch (e) {
            main.innerHTML = `<div class="alert alert-danger">Error loading documents: ${e.message}</div>`;
        }
    },

    async triggerSearch() {
        const val = document.getElementById('searchRackInput').value.trim();
        let query = {};
        if (val) {
            if (val.startsWith('{')) {
                try {
                    query = JSON.parse(val);
                } catch (e) {
                    await this.showError('Invalid JSON', 'Please enter valid JSON for search');
                    return;
                }
            } else {
                query = { id: val };
            }
        }
        this.showRack(this.currentDb, this.currentRack, query);
    },

    editDocument(doc) {
        document.getElementById('editDocId').value = doc.id;
        document.getElementById('editorIdDisplay').value = doc.id;

        const data = doc.data || doc;
        const jsonStr = JSON.stringify(data, null, 2);
        document.getElementById('editorData').value = jsonStr;

        this.setupEditor();
        if (this.editor) {
            this.editor.setValue(jsonStr);
            this.editor.setOption('readOnly', false);
        }

        // Render table view (editable)
        this.renderTableView(data, false);

        // Ensure Table View is active
        const tableTab = document.getElementById('table-tab');
        if (tableTab) {
            const tab = new bootstrap.Tab(tableTab);
            tab.show();
        }

        const modal = new bootstrap.Modal(document.getElementById('editorModal'));
        modal.show();
    },

    viewDocument(doc) {
        document.getElementById('editDocId').value = doc.id;
        document.getElementById('editorIdDisplay').value = doc.id;

        const data = doc.data || doc;
        document.getElementById('editorData').value = JSON.stringify(data, null, 2);

        // Render table view (read-only)
        this.renderTableView(data, true);

        // Change modal title to indicate read-only
        const modalTitle = document.querySelector('#editorModal .modal-title');
        if (modalTitle) modalTitle.textContent = 'View Document (Read-Only)';

        // Hide save button
        const saveBtn = document.querySelector('#editorModal .btn-primary');
        if (saveBtn) saveBtn.style.display = 'none';

        // Disable JSON editor
        const jsonStr = JSON.stringify(data, null, 2);
        document.getElementById('editorData').value = jsonStr;
        document.getElementById('editorData').readOnly = true;

        this.setupEditor();
        if (this.editor) {
            this.editor.setValue(jsonStr);
            this.editor.setOption('readOnly', true);
        }

        // Ensure Table View is active
        const tableTab = document.getElementById('table-tab');
        if (tableTab) {
            const tab = new bootstrap.Tab(tableTab);
            tab.show();
        }

        const modal = new bootstrap.Modal(document.getElementById('editorModal'));
        modal.show();

        // Reset after modal closes
        modal._element.addEventListener('hidden.bs.modal', function handler() {
            const modalTitle = document.querySelector('#editorModal .modal-title');
            if (modalTitle) modalTitle.textContent = 'Edit Document';
            const saveBtn = document.querySelector('#editorModal .btn-primary');
            if (saveBtn) saveBtn.style.display = '';
            if (saveBtn) saveBtn.style.display = '';
            document.getElementById('editorData').readOnly = false;
            if (app.editor) app.editor.setOption('readOnly', false);
            modal._element.removeEventListener('hidden.bs.modal', handler);
        });
    },

    async renderTableView(data, readOnly = false) {
        const container = document.getElementById('tableViewContent');

        // Fetch available racks for foreign key suggestions
        const racks = await this.fetchRacksForForeignKeys();

        let html = '<table class="table table-sm table-bordered" id="editableTable">';
        html += '<thead><tr><th style="width:200px;">Field</th><th>Value</th><th style="width:150px;">Type</th>';
        if (!readOnly) html += '<th style="width:50px;"></th>';
        html += '</tr></thead><tbody>';

        for (const [key, value] of Object.entries(data)) {
            html += this.generateTableRow(key, value, racks, readOnly);
        }

        html += '</tbody></table>';
        if (!readOnly) {
            html += `<button class="btn btn-sm btn-outline-primary" onclick="app.addFieldToTable()"><i class="bi bi-plus"></i> Add Field</button>`;
        }

        container.innerHTML = html;
    },


    generateTableRow(key, value, racks = [], readOnly = false) {
        const isForeignKey = key.endsWith('_id') || key.toLowerCase().includes('foreign');
        let valueType = typeof value;
        if (Array.isArray(value)) valueType = 'array';
        else if (value === null) valueType = 'string';

        const disabledAttr = readOnly ? ' disabled' : '';
        const readonlyAttr = readOnly ? ' readonly' : '';

        let html = '<tr>';
        html += `<td><input type="text" class="form-control form-control-sm table-field-name" value="${key}"${readonlyAttr}></td>`;
        html += '<td>';

        if (isForeignKey && racks.length > 0 && !readOnly) {
            // Foreign key field with autocomplete
            html += `<div class="input-group input-group-sm">`;
            html += `<input type="text" class="form-control table-input" data-field="${key}" value="${value || ''}" list="fk-list-${key}">`;
            html += `<button class="btn btn-outline-secondary btn-sm" onclick="app.browseRackForFK('${key}')" title="Browse related rack">`;
            html += `<i class="bi bi-search"></i></button>`;
            html += `</div>`;
            html += `<datalist id="fk-list-${key}">`;
            racks.forEach(r => {
                html += `<option value="${key.replace('_id', '')}-rack:${r}">`;
            });
            html += `</datalist>`;
            html += `<small class="text-muted"><i class="bi bi-link-45deg"></i> Foreign Key</small>`;
        } else if (typeof value === 'object' && value !== null) {
            html += `<textarea class="form-control form-control-sm table-input" data-field="${key}" rows="3"${readonlyAttr}>${JSON.stringify(value, null, 2)}</textarea>`;
        } else {
            html += `<input type="text" class="form-control form-control-sm table-input" data-field="${key}" value="${value || ''}"${readonlyAttr}>`;
        }

        html += '</td>';

        // Type selector dropdown
        html += '<td>';
        html += `<select class="form-select form-select-sm table-type-select"${disabledAttr}>`;
        html += `<option value="string" ${valueType === 'string' ? 'selected' : ''}>String</option>`;
        html += `<option value="number" ${valueType === 'number' ? 'selected' : ''}>Number</option>`;
        html += `<option value="integer" ${valueType === 'number' && Number.isInteger(value) ? 'selected' : ''}>Integer</option>`;
        html += `<option value="float" ${valueType === 'number' && !Number.isInteger(value) ? 'selected' : ''}>Float</option>`;
        html += `<option value="boolean" ${valueType === 'boolean' ? 'selected' : ''}>Boolean</option>`;
        html += `<option value="array" ${valueType === 'array' ? 'selected' : ''}>Array</option>`;
        html += `<option value="object" ${valueType === 'object' ? 'selected' : ''}>Object</option>`;
        html += '</select>';
        html += '</td>';

        // Delete button (only show if not read-only)
        if (!readOnly) {
            html += '<td class="text-center">';
            html += `<button class="btn btn-sm btn-ghost-danger" onclick="app.deleteTableRow(this)" title="Delete field"><i class="bi bi-trash"></i></button>`;
            html += '</td>';
        }

        html += '</tr>';
        return html;
    },

    async fetchRacksForForeignKeys() {
        if (!this.currentDb) return [];
        try {
            const res = await this.fetch(`/api/databases/${this.currentDb}/racks`);
            if (!res || !res.ok) return [];
            const data = await res.json();
            return data.racks || [];
        } catch (e) {
            return [];
        }
    },

    async browseRackForFK(fieldName) {
        // Future enhancement: Open a modal to browse documents from the related rack
        await this.showAlert('Coming Soon', `Browse documents for ${fieldName} - Feature coming soon!`, 'info');
    },

    async addFieldToTable() {
        // No prompt needed - create row with empty key so user can type it
        const racks = await this.fetchRacksForForeignKeys();
        const container = document.getElementById('tableViewContent');
        const table = container.querySelector('table tbody');

        const row = document.createElement('tr');
        row.innerHTML = this.generateTableRow('', '', racks);
        table.appendChild(row);

        // Focus the new field name input
        const nameInput = row.querySelector('.table-field-name');
        if (nameInput) nameInput.focus();
    },

    async deleteTableRow(button) {
        if (await this.confirm('Delete Field?', 'Are you sure you want to delete this field?', 'Delete', 'Cancel')) {
            button.closest('tr').remove();
        }
    },

    async saveDocument() {
        const id = document.getElementById('editDocId').value;

        // Check which tab is active
        const tableTab = document.getElementById('tableView');
        const isTableActive = tableTab.classList.contains('active') || tableTab.classList.contains('show');

        let data;
        try {
            if (isTableActive) {
                // Collect data from table view
                data = {};
                const table = document.getElementById('editableTable');
                const rows = table.querySelectorAll('tbody tr');

                rows.forEach(row => {
                    // Get field name from input
                    const fieldNameInput = row.querySelector('.table-field-name');
                    const valueInput = row.querySelector('.table-input');
                    const typeSelect = row.querySelector('.table-type-select');

                    if (!fieldNameInput || !valueInput || !typeSelect) return;

                    const field = fieldNameInput.value.trim();
                    if (!field) return; // Skip empty field names

                    let value = valueInput.value;
                    const type = typeSelect.value;

                    // Convert value based on selected type
                    switch (type) {
                        case 'integer':
                            value = parseInt(value, 10);
                            if (isNaN(value)) value = 0;
                            break;
                        case 'float':
                        case 'number':
                            value = parseFloat(value);
                            if (isNaN(value)) value = 0.0;
                            break;
                        case 'boolean':
                            value = value.toLowerCase() === 'true' || value === '1' || value === 'yes';
                            break;
                        case 'array':
                        case 'object':
                            try {
                                value = JSON.parse(value);
                            } catch (e) {
                                // If parse fails, keep as string
                                console.warn(`Failed to parse ${type} for field ${field}:`, e);
                            }
                            break;
                        case 'string':
                        default:
                            // Keep as string
                            break;
                    }

                    data[field] = value;
                });
            } else {
                // Use JSON view
                // Get value from CodeMirror if initialized
                const jsonStr = this.editor ? this.editor.getValue() : document.getElementById('editorData').value;
                data = JSON.parse(jsonStr);
            }
        } catch (e) {
            await this.showError('Invalid JSON', e.message);
            return;
        }

        const res = await this.fetch(`/api/databases/${this.currentDb}/racks/${this.currentRack}/documents/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('editorModal')).hide();
            this.showRack(this.currentDb, this.currentRack);
        } else {
            await this.showError('Error', 'Failed to save document');
        }
    },

    async createIndexModal() {
        const fieldName = prompt('Enter field name to index:');
        if (!fieldName) return;

        try {
            const res = await this.fetch(`/api/databases/${this.currentDb}/racks/${this.currentRack}/indexes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ field: fieldName })
            });

            if (res.ok) {
                await this.showSuccess('Index Created', `Index created on field: ${fieldName}`);
                this.showRack(this.currentDb, this.currentRack);
            } else {
                const err = await res.json();
                await this.showError('Error', err.error || 'Failed to create index');
            }
        } catch (e) {
            await this.showError('Error', 'Failed to create index');
        }
    },

    async viewIndexedData(dbName, rackName, fieldName) {
        try {
            // Fetch all documents and display them sorted by the indexed field
            const res = await this.fetch(`/api/databases/${dbName}/racks/${rackName}/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: {}, limit: 100 })
            });

            if (!res || !res.ok) {
                await this.showError('Error', 'Failed to fetch indexed data');
                return;
            }

            const rawData = await res.json();
            const docs = rawData.results || [];

            // Sort documents by the indexed field
            const sortedDocs = docs.filter(doc => {
                const data = doc.data || doc;
                return data.hasOwnProperty(fieldName);
            }).sort((a, b) => {
                const aVal = (a.data || a)[fieldName];
                const bVal = (b.data || b)[fieldName];
                if (aVal < bVal) return -1;
                if (aVal > bVal) return 1;
                return 0;
            });

            if (sortedDocs.length === 0) {
                await this.showAlert('No Data', `No documents found with field: ${fieldName}`, 'info');
                return;
            }

            // Build HTML table for indexed data
            let tableRows = '';
            sortedDocs.forEach(doc => {
                const data = doc.data || doc;
                const fieldValue = data[fieldName];
                const valueStr = typeof fieldValue === 'object' ? JSON.stringify(fieldValue) : fieldValue;

                tableRows += `
                    <tr>
                        <td class="font-monospace small">${doc.id}</td>
                        <td class="text-primary fw-bold">${valueStr}</td>
                        <td class="small text-muted text-truncate" style="max-width: 300px;">${JSON.stringify(data).substring(0, 100)}...</td>
                    </tr>
                `;
            });

            await Swal.fire({
                title: `Indexed Data: ${fieldName}`,
                html: `
                    <div class="text-start">
                        <p class="small text-muted">
                            <i class="bi bi-info-circle me-1"></i>
                            Showing ${sortedDocs.length} documents sorted by <strong>${fieldName}</strong>
                        </p>
                        <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
                            <table class="table table-sm table-hover">
                                <thead class="sticky-top bg-light">
                                    <tr>
                                        <th>Document ID</th>
                                        <th><i class="bi bi-lightning-charge text-warning"></i> ${fieldName}</th>
                                        <th>Preview</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `,
                icon: 'info',
                width: '800px',
                background: this.theme === 'dark' ? '#1a1d29' : '#fff',
                color: this.theme === 'dark' ? '#e0e0e0' : '#333',
                confirmButtonText: 'Close'
            });
        } catch (e) {
            await this.showError('Error', 'Failed to view indexed data: ' + e.message);
        }
    },

    async deleteIndex(dbName, rackName, fieldName) {
        if (!await this.confirmDanger(
            'Delete Index?',
            `Are you sure you want to delete the index on field "${fieldName}"? This will slow down queries on this field.`,
            'Delete Index'
        )) return;

        try {
            const res = await this.fetch(`/api/databases/${dbName}/racks/${rackName}/indexes/${fieldName}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                await this.showSuccess('Index Deleted', `Index on "${fieldName}" has been deleted`);
                this.showRack(dbName, rackName);
            } else {
                const err = await res.json();
                await this.showError('Error', err.error || 'Failed to delete index');
            }
        } catch (e) {
            await this.showError('Error', 'Failed to delete index: ' + e.message);
        }
    },

    async deleteDocument(id) {
        if (!await this.confirmDanger('Delete Document?', 'This action cannot be undone.', 'Delete')) return;

        await this.fetch(`/api/databases/${this.currentDb}/racks/${this.currentRack}/documents/${id}`, {
            method: 'DELETE'
        });

        this.showRack(this.currentDb, this.currentRack);
    },

    async deleteDatabase(dbName) {
        if (!await this.confirmDanger('Delete Database?', `Are you sure you want to delete database "${dbName}"? This action cannot be undone and all data will be lost!`, 'Delete Database')) return;
        await this.fetch(`/api/databases/${dbName}`, { method: 'DELETE' });
        this.loadDatabases();
        this.showDashboard();
    },

    async createDatabase() {
        const name = document.getElementById('newDbName').value;
        if (!name) return;

        await this.fetch('/api/databases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        bootstrap.Modal.getInstance(document.getElementById('createDbModal')).hide();
        this.loadDatabases();
    },

    async createDocument() {
        // Auto-generate ID based on existing documents
        let newId;

        try {
            // Fetch existing documents to determine next ID
            const res = await this.fetch(`/api/databases/${this.currentDb}/racks/${this.currentRack}/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: {}, limit: 1000 }) // Get all docs to find max ID
            });

            const rawData = res && res.ok ? await res.json() : {};
            const docs = rawData.results || [];

            if (docs.length === 0) {
                // First document - start with ID 1
                newId = '1';
            } else {
                // Find the highest numeric ID
                const numericIds = docs
                    .map(doc => doc.id)
                    .filter(id => /^\d+$/.test(id)) // Only numeric IDs
                    .map(id => parseInt(id, 10));

                if (numericIds.length > 0) {
                    // Increment the highest numeric ID
                    const maxId = Math.max(...numericIds);
                    newId = String(maxId + 1);
                } else {
                    // No numeric IDs found, use timestamp-based ID
                    newId = `doc_${Date.now()}`;
                }
            }
        } catch (e) {
            console.error('Failed to generate ID, using timestamp:', e);
            newId = `doc_${Date.now()}`;
        }

        // Open editor with new ID
        document.getElementById('editDocId').value = newId;
        document.getElementById('editorIdDisplay').value = newId;
        const initialJson = "{\n  \n}";
        document.getElementById('editorData').value = initialJson;

        this.setupEditor();
        if (this.editor) {
            this.editor.setValue(initialJson);
            this.editor.setOption('readOnly', false);
        }

        // Render empty table view
        this.renderTableView({});

        // Ensure Table View is active
        const tableTab = document.getElementById('table-tab');
        if (tableTab) {
            const tab = new bootstrap.Tab(tableTab);
            tab.show();
        }

        new bootstrap.Modal(document.getElementById('editorModal')).show();
    },

    showChangePassword() {
        document.getElementById('newPasswordInput').value = '';
        new bootstrap.Modal(document.getElementById('changePasswordModal')).show();
    },

    async changePassword() {
        const password = document.getElementById('newPasswordInput').value;
        if (!password || password.length < 6) {
            await this.showWarning('Invalid Password', 'Password must be at least 6 characters');
            return;
        }

        try {
            const res = await this.fetch('/api/auth/me/password', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            if (res.ok) {
                bootstrap.Modal.getInstance(document.getElementById('changePasswordModal')).hide();
                await this.showSuccess('Success', 'Password updated successfully');
            } else {
                const err = await res.json();
                await this.showError('Error', err.error || 'Failed to update password');
            }
        } catch (e) {
            await this.showError('Error', 'Failed to update password');
        }
    },

    async showErrorLegacy(msg) {
        const alert = document.getElementById('errorAlert');
        if (alert) {
            alert.textContent = msg;
            alert.classList.remove('d-none');
        } else {
            await this.showError('Error', msg);
        }
    }
};
