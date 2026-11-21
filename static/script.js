/* ===================================================
   Superior Repo Downloader — script.js
   =================================================== */

let githubProfilesData = [];
let githubProfilesInfo = [];
let fullTableData = [];       // All rows for search filtering
let fullTableColumns = [];
let plagiarismCache = null;   // Cache last plagiarism result

// ─── GITHUB FOLLOW STATE ────────────────────────────
let myFollowingSet = new Set();
let followingLoaded = false;
let batchFollowPollTimer = null;

function extractGitHubUsername(urlOrStr) {
    if (!urlOrStr) return null;
    let s = urlOrStr.toString().trim();
    if (!s || s.toLowerCase() === 'nan' || s === '—') return null;
    // Match https://github.com/username or github.com/username
    const match = s.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_\-\.]+)/i);
    if (match && match[1]) {
        let u = match[1].replace(/\/+$/, '');
        if (!['orgs', 'settings', 'notifications', 'explore', 'marketplace', 'features'].includes(u.toLowerCase())) {
            return u;
        }
    }
    // Match @username
    if (s.startsWith('@') && s.length > 1) {
        return s.slice(1);
    }
    return null;
}

// ─── DARK MODE ──────────────────────────────────────
function initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved);
}

function updateThemeIcon(theme) {
    const icon = document.getElementById('themeIcon');
    if (!icon) return;
    if (theme === 'dark') {
        icon.setAttribute('data-lucide', 'sun');
    } else {
        icon.setAttribute('data-lucide', 'moon');
    }
    lucide.createIcons();
}

function toggleDarkMode() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeIcon(next);
}

// ─── TOAST NOTIFICATIONS ────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
    const icons = { 
        success: '<i data-lucide="check-circle"></i>', 
        error: '<i data-lucide="alert-circle"></i>', 
        warning: '<i data-lucide="alert-triangle"></i>', 
        info: '<i data-lucide="info"></i>' 
    };
    const container = document.getElementById('toastContainer');

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || icons.info}</span><span>${message}</span>`;

    container.appendChild(toast);
    lucide.createIcons();

    setTimeout(() => {
        toast.classList.add('hiding');
        toast.addEventListener('animationend', () => toast.remove());
    }, duration);

    return toast;
}

// ─── TOKEN MANAGEMENT ───────────────────────────────
function toggleTokenSection() {
    const content = document.getElementById('tokenContent');
    const chevron = document.getElementById('tokenChevron');
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'block' : 'none';
    chevron.classList.toggle('open', isHidden);
}

function checkRateLimit() {
    $.get('/check_rate_limit', function (response) {
        const statusEl = document.getElementById('tokenStatus');
        if (response.success) {
            if (response.has_token) {
                statusEl.innerHTML = `<i data-lucide="check-circle-2" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i> Token active (${response.remaining}/${response.limit})`;
                statusEl.className = 'token-status active';
            } else {
                statusEl.innerHTML = `<i data-lucide="alert-triangle" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i> No token (${response.remaining}/${response.limit})`;
                statusEl.className = 'token-status warning';
            }
        } else {
            statusEl.innerHTML = '<i data-lucide="x-circle" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i> Error';
            statusEl.className = 'token-status error';
        }
        lucide.createIcons();
    });
}

function setGitHubToken() {
    const token = document.getElementById('githubToken').value.trim();
    if (!token) { showToast('Please enter a token', 'warning'); return; }

    $.ajax({
        url: '/set_github_token',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ token }),
        success(response) {
            if (response.success) {
                showToast(response.message, 'success');
                document.getElementById('githubToken').value = '';
                checkRateLimit();
            } else {
                showToast('Error: ' + response.message, 'error');
            }
        },
        error() { showToast('Network error setting token', 'error'); }
    });
}

function clearGitHubToken() {
    $.ajax({
        url: '/set_github_token',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ token: '' }),
        success() {
            showToast('Token cleared', 'info');
            checkRateLimit();
        },
        error() { showToast('Network error', 'error'); }
    });
}

// ─── TAB SWITCHING ──────────────────────────────────
function switchTab(tabType) {
    const isQuick = tabType === 'quick';
    document.getElementById('quickDownloadTab').classList.toggle('active', isQuick);
    document.getElementById('selectiveDownloadTab').classList.toggle('active', !isQuick);
    document.getElementById('quickDownloadSection').style.display = isQuick ? 'block' : 'none';
    document.getElementById('selectiveDownloadSection').style.display = isQuick ? 'none' : 'block';
}

// ─── FILE UPLOAD ────────────────────────────────────
function updateFileLabel(input) {
    const label = document.getElementById('fileLabel');
    label.textContent = input.files[0] ? input.files[0].name : 'Choose .xlsx / .xls file…';
}

function uploadFile() {
    const fileInput = document.getElementById('fileInput').files[0];
    if (!fileInput) { showToast('Please select a file first!', 'warning'); return; }

    const formData = new FormData();
    formData.append('file', fileInput);

    showToast('Uploading and parsing…', 'info', 2000);

    $.ajax({
        url: '/upload',
        type: 'POST',
        data: formData,
        contentType: false,
        processData: false,
        success(response) {
            if (response.success) {
                const select = $('#sheetSelect');
                select.empty();
                response.sheets.forEach(sheet => select.append(new Option(sheet, sheet)));
                $('#sheetSection').show();
                showToast(`File uploaded! ${response.sheets.length - 1} sheets found.`, 'success');
            } else {
                showToast(response.message, 'error');
            }
        },
        error() { showToast('Upload failed — check the file format.', 'error'); }
    });
}

// ─── SHEET LOADING ──────────────────────────────────
function loadSheet() {
    const sheetName = $('#sheetSelect').val();

    // Reset state
    githubProfilesData = [];
    githubProfilesInfo = [];
    fullTableData = [];
    fullTableColumns = [];
    plagiarismCache = null;

    $('#githubProfilesContainer').html('');
    $('#fetchProfilesBtn').show().prop('disabled', false);
    $('#downloadSelectedBtn').hide();
    $('#selectionSummary').hide();
    $('#tableContainer').html('');
    $('#searchSection').hide();
    $('#followManagerCard').hide();
    $('#summaryPanel').hide();
    $('#plagiarismPanel').hide();

    $.ajax({
        url: '/load_sheet',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ sheet_name: sheetName }),
        success(response) {
            if (response.success) {
                fullTableColumns = response.columns;
                fullTableData = response.data;
                githubProfilesInfo = response.github_profiles_info || [];

                renderTable(fullTableData, fullTableColumns);

                $('#downloadOptions').show();
                $('#searchSection').show();
                updateRowCount(fullTableData.length, fullTableData.length);
                updateRepoColumnsInfo(response.has_github_repo, response.has_github_project_repo);

                // Update follow toolbar stats and automatically sync following status
                updateFollowToolbarStats();
                checkFollowingStatus(false);

                const profileCount = githubProfilesInfo.length;
                if (profileCount > 0) {
                    $('#fetchProfilesBtn').text(`🔄 Fetch GitHub Profiles (${profileCount} found)`);
                } else {
                    $('#fetchProfilesBtn').text('🔄 No GitHub Profiles Found').prop('disabled', true);
                }

                showToast(`Loaded ${fullTableData.length} rows from "${sheetName}"`, 'success');
            } else {
                showToast(response.message, 'error');
            }
        },
        error() { showToast('Failed to load sheet.', 'error'); }
    });
}

// ─── TABLE RENDERING ────────────────────────────────
function renderTable(data, columns) {
    if (!data.length) {
        $('#tableContainer').html('<p style="padding:20px;color:var(--text-muted)">No rows to display.</p>');
        return;
    }

    let html = '<table><thead><tr>';
    columns.forEach(col => {
        html += `<th>${col}</th>`;
    });
    html += '</tr></thead><tbody>';

    data.forEach(row => {
        html += '<tr>';
        columns.forEach(col => {
            const val = (row[col] || '').toString().trim();
            const isUrl = val.startsWith('http');
            const isEmpty = val === '';
            const isProfileCol = (col === 'GitHub Profiles' || col.toLowerCase().includes('profile') || col.toLowerCase() === 'github');
            const username = isProfileCol ? extractGitHubUsername(val) : null;

            if (isEmpty) {
                html += `<td class="empty-cell">—</td>`;
            } else if (username) {
                const uLower = username.toLowerCase();
                const isFollowing = myFollowingSet.has(uLower);
                html += `<td class="url-cell">
                    <div class="cell-flex">
                        <a href="${val}" target="_blank" rel="noopener" title="${val}">@${username}</a>
                        <button class="copy-btn" onclick="copyText('${escapeJs(val)}')" title="Copy URL"><i data-lucide="copy"></i></button>
                        <button class="follow-btn ${isFollowing ? 'following' : ''}" data-username="${username}" onclick="toggleFollowUser('${username}', this)" title="${isFollowing ? 'Click to Unfollow @' + username : 'Click to Follow @' + username}">
                            <i data-lucide="${isFollowing ? 'check' : 'user-plus'}"></i>
                            <span>${isFollowing ? 'Following' : 'Follow'}</span>
                        </button>
                    </div>
                </td>`;
            } else if (isUrl) {
                html += `<td class="url-cell">
                    <a href="${val}" target="_blank" rel="noopener" title="${val}">${truncate(val, 35)}</a>
                    <button class="copy-btn" onclick="copyText('${escapeJs(val)}')" title="Copy URL"><i data-lucide="copy"></i></button>
                </td>`;
            } else {
                html += `<td>${val}</td>`;
            }
        });
        html += '</tr>';
    });

    html += '</tbody></table>';
    $('#tableContainer').html(html);
    lucide.createIcons();
}

function truncate(str, max) {
    return str.length > max ? str.slice(0, max) + '…' : str;
}

function escapeJs(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ─── COPY TO CLIPBOARD ──────────────────────────────
function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!', 'success', 2000);
    }).catch(() => {
        showToast('Could not copy — check browser permissions.', 'error');
    });
}

// ─── SEARCH / FILTER ────────────────────────────────
function filterTable() {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    document.getElementById('clearSearchBtn').style.display = query ? 'inline-flex' : 'none';

    if (!query) {
        renderTable(fullTableData, fullTableColumns);
        updateRowCount(fullTableData.length, fullTableData.length);
        updateFollowToolbarStats();
        return;
    }

    const filtered = fullTableData.filter(row =>
        Object.values(row).some(val => val.toString().toLowerCase().includes(query))
    );

    renderTable(filtered, fullTableColumns);
    updateRowCount(filtered.length, fullTableData.length);
    updateFollowToolbarStats();
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    filterTable();
}

function updateRowCount(shown, total) {
    const el = document.getElementById('rowCount');
    if (!el) return;
    el.textContent = shown === total ? `${total} rows` : `${shown} of ${total} rows`;
}

// ─── REPO COLUMN INFO ───────────────────────────────
function updateRepoColumnsInfo(hasGitHubRepo, hasGitHubProjectRepo) {
    let cols = [];
    if (hasGitHubRepo) cols.push('GitHub Repo');
    if (hasGitHubProjectRepo) cols.push('GitHub Project Repo');

    let html = '<strong>Available repo columns:</strong> ';
    if (cols.length) {
        html += cols.map(c => `<span class="column-badge">${c}</span>`).join(' ');
    } else {
        html += '<span class="column-badge warning">No repo columns found</span>';
    }
    $('#repoColumnsInfo').html(html);
}

// ─── FETCH GITHUB PROFILES ──────────────────────────
function fetchGitHubProfiles() {
    if (!githubProfilesInfo.length) {
        showToast('No GitHub profiles found in the data.', 'warning');
        return;
    }

    $('#profilesLoadingIndicator').show();
    $('#fetchProfilesBtn').prop('disabled', true);
    $('#githubProfilesContainer').html('');

    $.ajax({
        url: '/fetch_profiles',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ profiles: githubProfilesInfo }),
        success(response) {
            $('#profilesLoadingIndicator').hide();
            if (response.success) {
                githubProfilesData = response.github_profiles || [];
                displayGithubProfiles();
                $('#fetchProfilesBtn').html('<i data-lucide="check"></i> Profiles Loaded').prop('disabled', true);
                showToast(`Loaded ${githubProfilesData.length} profiles.`, 'success');
            } else {
                showToast(response.message || 'Error fetching profiles', 'error');
                $('#fetchProfilesBtn').prop('disabled', false);
            }
        },
        error() {
            $('#profilesLoadingIndicator').hide();
            showToast('Error fetching GitHub profiles.', 'error');
            $('#fetchProfilesBtn').prop('disabled', false);
        }
    });
}

function displayGithubProfiles() {
    const container = document.getElementById('githubProfilesContainer');

    if (!githubProfilesData.length) {
        container.innerHTML = '<p class="no-profiles">No GitHub profiles with repositories found.</p>';
        return;
    }

    let totalRepos = githubProfilesData.reduce((s, p) => s + p.repositories.length, 0);

    let html = `
        <div class="profiles-header">
            <h4><i data-lucide="book-open"></i> Select Repositories to Download</h4>
            <p class="profile-summary">${githubProfilesData.length} profiles · ${totalRepos} total repositories</p>
            <div class="selection-actions">
                <button type="button" class="action-btn" onclick="selectAllRepos()">Select All</button>
                <button type="button" class="action-btn" onclick="deselectAllRepos()">Deselect All</button>
            </div>
        </div>`;

    githubProfilesData.forEach((profile, pi) => {
        html += `
        <div class="profile-section">
            <div class="profile-header">
                <h5><i data-lucide="user"></i> ${profile.name} <span class="reg-no">(${profile.reg_no})</span></h5>
                <a href="${profile.profile_url}" target="_blank" rel="noopener" class="profile-link"><i data-lucide="external-link"></i> View Profile</a>
            </div>
            <div class="repositories">`;

        profile.repositories.forEach((repo, ri) => {
            const cbId = `repo_${pi}_${ri}`;
            const forkBadge = repo.fork ? `<span class="repo-fork-badge">FORK</span>` : '';
            html += `
                <div class="repo-item">
                    <input type="checkbox" id="${cbId}"
                           data-profile-index="${pi}" data-repo-index="${ri}"
                           onchange="updateSelectedRepos()">
                    <label for="${cbId}">
                        <div class="repo-name"><i data-lucide="folder"></i> ${repo.name}${forkBadge}</div>
                        <div class="repo-desc">${repo.description}</div>
                        <div class="repo-meta">
                            <span><i data-lucide="code-2"></i> ${repo.language || 'Unknown'}</span>
                            <span><i data-lucide="star"></i> ${repo.stars}</span>
                            <span><i data-lucide="git-fork"></i> ${repo.forks_count || 0}</span>
                            <span><i data-lucide="calendar"></i> ${new Date(repo.updated_at).toLocaleDateString()}</span>
                        </div>
                    </label>
                </div>`;
        });

        html += '</div></div>';
    });

    container.innerHTML = html;
    lucide.createIcons();
}

function selectAllRepos() {
    document.querySelectorAll('#githubProfilesContainer input[type="checkbox"]').forEach(cb => cb.checked = true);
    updateSelectedRepos();
}
function deselectAllRepos() {
    document.querySelectorAll('#githubProfilesContainer input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateSelectedRepos();
}

function updateSelectedRepos() {
    const checked = document.querySelectorAll('#githubProfilesContainer input[type="checkbox"]:checked');
    const btn = document.getElementById('downloadSelectedBtn');
    const summary = document.getElementById('selectionSummary');

    if (checked.length > 0) {
        btn.style.display = 'inline-flex';
        btn.innerHTML = `<i data-lucide="download-cloud"></i> Download Selected Repositories (${checked.length})`;
        summary.style.display = 'block';
        document.getElementById('selectedCount').textContent = checked.length;
        lucide.createIcons();
    } else {
        btn.style.display = 'none';
        summary.style.display = 'none';
    }
}

// ─── DOWNLOAD ALL ───────────────────────────────────
function downloadRepos() {
    const sheetName = $('#sheetSelect').val();

    $.ajax({
        url: '/download_repos',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ sheet_name: sheetName }),
        beforeSend() {
            $('#downloadBtn').prop('disabled', true);
            $('#progressSection').show();
            $('#progressText').text('Starting…');
            $('#progressBar').css('width', '0%');
            showToast('Download started!', 'info');
        },
        success() { startProgressTracking('download'); },
        error() {
            showToast('Error starting download.', 'error');
            $('#downloadBtn').prop('disabled', false);
        }
    });
}

// ─── DOWNLOAD SELECTED ──────────────────────────────
function downloadSelectedRepos() {
    const checkboxes = document.querySelectorAll('#githubProfilesContainer input[type="checkbox"]:checked');
    const selectedRepos = [];

    checkboxes.forEach(cb => {
        const profile = githubProfilesData[parseInt(cb.dataset.profileIndex)];
        const repo = profile.repositories[parseInt(cb.dataset.repoIndex)];
        selectedRepos.push({ reg_no: profile.reg_no, name: profile.name, repo_url: repo.url, repo_name: repo.name });
    });

    if (!selectedRepos.length) { showToast('Please select at least one repository.', 'warning'); return; }

    $.ajax({
        url: '/download_selected_repos',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ selected_repos: selectedRepos }),
        beforeSend() {
            $('#downloadSelectedBtn').prop('disabled', true);
            $('#progressSection').show();
            $('#progressText').text('Starting selective download…');
            $('#progressBar').css('width', '0%');
            showToast(`Downloading ${selectedRepos.length} selected repos…`, 'info');
        },
        success() { startProgressTracking('selective'); },
        error() {
            showToast('Error downloading selected repositories.', 'error');
            $('#downloadSelectedBtn').prop('disabled', false);
        }
    });
}

// ─── PROGRESS TRACKING ──────────────────────────────
function startProgressTracking(mode) {
    let completedCount = 0;
    let totalCount = 0;
    let finished = false;

    function handleProgressUpdate(c, t, msg) {
        if (finished) return;
        completedCount = parseInt(c) || 0;
        totalCount = parseInt(t) || 0;
        const pct = totalCount > 0 ? Math.min(100, Math.round((completedCount / totalCount) * 100)) : 0;

        $('#progressBar').css('width', pct + '%');
        $('#progressText').text(msg || (totalCount > 0 ? `Downloaded ${completedCount} / ${totalCount}` : 'Preparing downloads...'));

        if (totalCount > 0 && completedCount >= totalCount) {
            finished = true;
            stopTracking();
            $('#downloadBtn').prop('disabled', false);
            $('#downloadSelectedBtn').prop('disabled', false);
            $('#toolsRow').show();
            showToast('All downloads complete!', 'success', 6000);
        }
    }

    // 1. Dual-Track: Fast 400ms polling fallback guarantees zero UI freezing
    const pollInterval = setInterval(function() {
        $.get('/download_progress_status', function(data) {
            if (data && data.total !== undefined) {
                handleProgressUpdate(data.completed, data.total, data.message);
            }
        });
    }, 400);

    // 2. Real-time EventSource SSE
    let evtSource = null;
    try {
        evtSource = new EventSource('/progress');
        evtSource.onmessage = function (event) {
            if (event.data) {
                const parts = event.data.split(',');
                if (parts.length >= 3) {
                    handleProgressUpdate(parts[0], parts[1], parts.slice(2).join(','));
                }
            }
        };
        evtSource.onerror = function () {
            if (evtSource) {
                try { evtSource.close(); } catch(e) {}
                evtSource = null;
            }
        };
    } catch(err) {
        console.warn("SSE not available, falling back to polling", err);
    }

    function stopTracking() {
        clearInterval(pollInterval);
        if (evtSource) {
            try { evtSource.close(); } catch(e) {}
            evtSource = null;
        }
    }
}

// ─── SUMMARY REPORT ─────────────────────────────────
function showSummaryReport() {
    const panel = document.getElementById('summaryPanel');
    panel.style.display = 'block';
    document.getElementById('summaryContent').innerHTML =
        '<div class="loading-indicator"><div class="spinner"></div><span>Loading summary…</span></div>';

    $.get('/get_summary', function (response) {
        if (!response.success) {
            document.getElementById('summaryContent').innerHTML =
                `<p style="color:var(--text-muted);padding:20px">${response.message}</p>`;
            return;
        }

        const { total, succeeded, failed, success_rate, entries } = response;

        let html = `
        <div class="stats-grid">
            <div class="stat-card stat-total"><div class="stat-value">${total}</div><div class="stat-label">Total</div></div>
            <div class="stat-card stat-success"><div class="stat-value">${succeeded}</div><div class="stat-label">Succeeded</div></div>
            <div class="stat-card stat-fail"><div class="stat-value">${failed}</div><div class="stat-label">Failed</div></div>
            <div class="stat-card stat-rate"><div class="stat-value">${success_rate}%</div><div class="stat-label">Success Rate</div></div>
        </div>`;

        html += `<div class="summary-table-wrap"><table class="summary-table">
            <thead><tr>
                <th>#</th><th>Sheet</th><th>Reg No</th><th>Name</th>
                <th>Source</th><th>Branch</th><th>Status</th><th>Repo URL</th>
            </tr></thead><tbody>`;

        entries.forEach((e, i) => {
            const badge = e.status === 'success'
                ? `<span class="row-status-badge success"><i data-lucide="check"></i> OK</span>`
                : `<span class="row-status-badge failed"><i data-lucide="alert-circle"></i> Failed</span>`;
            const urlShort = truncate(e.repo_url || '', 40);
            html += `<tr>
                <td>${i + 1}</td>
                <td>${e.sheet}</td>
                <td>${e.reg_no}</td>
                <td>${e.name}</td>
                <td>${e.source_type}</td>
                <td>${e.branch || '—'}</td>
                <td>${badge}</td>
                <td class="url-cell">
                    <a href="${e.repo_url}" target="_blank">${urlShort}</a>
                    <button class="copy-btn" onclick="copyText('${escapeJs(e.repo_url)}')" title="Copy"><i data-lucide="copy"></i></button>
                </td>
            </tr>`;
        });

        html += '</tbody></table></div>';
        document.getElementById('summaryContent').innerHTML = html;
        lucide.createIcons();
    });

    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeSummaryPanel() {
    document.getElementById('summaryPanel').style.display = 'none';
}

// ─── PLAGIARISM CHECK ───────────────────────────────
function runPlagiarismCheck() {
    const panel = document.getElementById('plagiarismPanel');
    panel.style.display = 'block';
    document.getElementById('plagiarismContent').innerHTML = '';
    const loadingEl = document.getElementById('plagiarismLoadingIndicator');
    loadingEl.style.display = 'flex';
    loadingEl.innerHTML = 
        '<div style="text-align:center">' +
        '<div style="font-size:48px;color:var(--primary);font-weight:700">1%</div>' +
        '<div style="color:var(--text-muted);margin-top:10px;font-size:15px">Scanning downloaded repositories...</div>' +
        '</div>';

    $.get('/check_plagiarism', function (response) {
        const pollInterval = setInterval(function() {
            $.get('/plagiarism_status', function(status) {
                if (status.progress) {
                    const pct = status.progress.percent !== undefined 
                        ? status.progress.percent 
                        : (status.progress.total > 0 ? Math.round((status.progress.current / status.progress.total) * 100) : 0);
                    
                    const countMsg = (status.total_pairs > 0) 
                        ? `${status.total_repos || ''} repos · ${status.total_pairs.toLocaleString()} comparison pairs`
                        : '';

                    loadingEl.innerHTML = 
                        '<div style="text-align:center">' +
                        '<div style="font-size:48px;color:var(--primary);font-weight:700">' + pct + '%</div>' +
                        '<div style="color:var(--text-muted);margin-top:10px;font-size:15px">' + (status.progress.message || 'Analyzing similarity...') + '</div>' +
                        (countMsg ? '<div style="color:var(--text-muted);font-size:12px;margin-top:6px">' + countMsg + '</div>' : '') +
                        '</div>';
                }
                if (!status.in_progress) {
                    clearInterval(pollInterval);
                    loadingEl.style.display = 'none';
                    if (status.results && status.results.length > 0) {
                        plagiarismCache = {
                            similarities: status.results,
                            total_repos: status.total_repos || 0,
                            total_pairs: status.total_pairs || 0,
                            suspicious_pairs: status.suspicious_pairs || status.results.length
                        };
                        renderPlagiarismResults(plagiarismCache, parseInt(document.getElementById('similarityThreshold').value));
                        showToast(`Analysis complete! Found ${status.results.length} suspicious pairs.`, 'success');
                    } else {
                        document.getElementById('plagiarismContent').innerHTML = 
                            '<p style="color:var(--text-muted);padding:30px;text-align:center;font-size:15px">No suspicious plagiarism detected above the 25% threshold.</p>';
                    }
                }
            });
        }, 400); // 400ms fast fluid polling
    }).fail(function () {
        loadingEl.style.display = 'none';
        document.getElementById('plagiarismContent').innerHTML =
            '<p style="color:var(--danger);padding:20px;text-align:center">Error starting plagiarism check.</p>';
    });

    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyThreshold() {
    if (!plagiarismCache) return;
    const threshold = parseInt(document.getElementById('similarityThreshold').value);
    renderPlagiarismResults(plagiarismCache, threshold);
}

function renderPlagiarismResults(data, threshold = 25) {
    const similarities = data.similarities || [];
    const total_repos = data.total_repos || (similarities.length ? 2 : 0);
    const total_pairs = data.total_pairs || similarities.length;
    const filtered = similarities.filter(s => (s.combined_score || 0) >= threshold);

    const rc = { critical: 0, high: 0, medium: 0, low: 0 };
    similarities.forEach(s => {
        const r = (s.risk || 'medium').toLowerCase();
        if (rc[r] !== undefined) rc[r]++;
    });

    let html = `
    <div class="plag-stats">
        <div class="plag-stat"><i data-lucide="folder"></i> <strong>${total_repos}</strong> repos scanned</div>
        <div class="plag-stat"><i data-lucide="link"></i> <strong>${total_pairs}</strong> pairs compared</div>
        <div class="plag-stat" style="color:var(--danger)"><i data-lucide="alert-octagon"></i> <strong>${rc.critical}</strong> Critical ≥80%</div>
        <div class="plag-stat" style="color:var(--warning)"><i data-lucide="alert-triangle"></i> <strong>${rc.high}</strong> High 50–79%</div>
        <div class="plag-stat" style="color:var(--info)"><i data-lucide="circle"></i> <strong>${rc.medium}</strong> Medium 25–49%</div>
    </div>`;

    if (!filtered.length) {
        html += `<div class="plag-no-results">
            <div style="font-size:48px;color:var(--success)"><i data-lucide="check-circle-2" style="width:48px;height:48px;"></i></div>
            <div style="font-size:16px;margin-top:10px;color:var(--success)">No suspicious pairs above ${threshold}%</div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:6px">All repos look original at this threshold.</div>
        </div>`;
    } else {
        filtered.forEach(s => {
            const a = s.student_a, b = s.student_b;
            const barW = Math.min(s.combined_score, 100);

            // Build layers
            const col = v => v >= 80 ? 'var(--danger)' : v >= 50 ? 'var(--warning)' : v >= 25 ? 'var(--info)' : 'var(--text-muted)';
            const bar = (v) => `<div class="layer-bar-bg"><div class="layer-bar-fill" style="width:${Math.min(v,100)}%;background:${col(v)}"></div></div>`;

            // Detect if either has AI markers
            const aiFound = (a.ai_score >= 25 || b.ai_score >= 25);
            const aiMarkers = [...new Set([...(a.ai_markers || []), ...(b.ai_markers || [])])];

            const layers = [
                { label: 'MD5 Exact',    icon: 'key', score: s.md5_score,  note: `${s.matching_files_md5} identical files` },
                { label: 'AST Structure', icon: 'git-branch', score: s.ast_score,  note: s.ast_score != null ? `${s.ast_comparisons} .py files` : 'No Python files matched' },
                { label: 'Text Sim.',     icon: 'file-text', score: s.text_score, note: s.text_score != null ? `${s.text_comparisons} files` : 'No text files matched' },
                { label: 'AI Detection',  icon: 'cpu', score: Math.max(a.ai_score, b.ai_score), note: aiFound ? `Detected: ${aiMarkers.join(', ')}` : 'No AI markers found' },
            ];

            let layersHtml = '<div class="layer-list">';
            layers.forEach(l => {
                if (l.score === null || l.score === undefined) {
                    layersHtml += `<div class="layer-row layer-na">
                        <span class="layer-label"><i data-lucide="${l.icon}"></i> ${l.label}</span>
                        <span style="grid-column:2/5;color:var(--text-muted)">${l.note}</span>
                    </div>`;
                } else {
                    layersHtml += `<div class="layer-row">
                        <span class="layer-label"><i data-lucide="${l.icon}"></i> ${l.label}</span>
                        <div class="layer-bar-wrap">${bar(l.score)}</div>
                        <span class="layer-score" style="color:${col(l.score)}">${l.score}%</span>
                        <span class="layer-note">${l.note}</span>
                    </div>`;
                }
            });
            layersHtml += '</div>';

            // Sample matching files
            let matchesHtml = '';
            if (s.sample_matches && s.sample_matches.length) {
                matchesHtml = `<details style="margin-top:10px">
                    <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none">
                        <i data-lucide="files" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i> ${s.matching_files_md5} identical file${s.matching_files_md5 !== 1 ? 's' : ''} — expand for evidence
                    </summary>
                    <div class="matching-files">`;
                s.sample_matches.forEach(m => {
                    matchesHtml += `<div class="matching-file-row">
                        <span class="arrow">→</span><span>${m.file_a}</span>
                        <span style="color:var(--text-muted);margin:0 6px">↔</span>
                        <span>${m.file_b}</span>
                    </div>`;
                });
                matchesHtml += `</div></details>`;
            }

            const aiBadge = aiFound ? `<span class="ai-badge"><i data-lucide="cpu"></i> AI CONTENT</span>` : '';

            html += `
            <div class="plag-card risk-${s.risk} ${aiFound ? 'has-ai' : ''}">
                <div class="plag-header">
                    <div class="plag-students">
                        <strong>${a.name}</strong><span class="plag-vs">vs</span><strong>${b.name}</strong>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;">
                        ${aiBadge}
                        <span class="risk-badge risk-${s.risk}">${s.risk.toUpperCase()}</span>
                    </div>
                </div>
                <div class="similarity-bar-wrap risk-${s.risk}">
                    <div class="similarity-label">
                        <span style="font-size:12px;color:var(--text-muted)">Combined Risk Score</span>
                        <strong style="font-size:20px">${s.combined_score}%</strong>
                    </div>
                    <div class="similarity-bar-bg" style="height:10px">
                        <div class="similarity-bar-fill" style="width:${barW}%"></div>
                    </div>
                </div>
                ${layersHtml}
                <div class="plag-meta" style="margin-top:10px">
                    <span><i data-lucide="fingerprint"></i> ${a.reg_no} vs ${b.reg_no}</span>
                    <span><i data-lucide="layout"></i> ${a.sheet} vs ${b.sheet}</span>
                    <span><i data-lucide="files"></i> ${a.file_count} files vs ${b.file_count} files</span>
                </div>
                ${matchesHtml}
            </div>`;
        });
    }

    document.getElementById('plagiarismContent').innerHTML = html;
    lucide.createIcons();
}

function closePlagiarismPanel() {
    document.getElementById('plagiarismPanel').style.display = 'none';
}

// ─── GITHUB PROFILE FOLLOW & BATCH MANAGER ───────────

function toggleFollowUser(username, btnEl) {
    if (!username) return;
    const $btn = $(btnEl);
    const uLower = username.toLowerCase();
    const isCurrentlyFollowing = myFollowingSet.has(uLower);
    const action = isCurrentlyFollowing ? 'unfollow' : 'follow';
    const endpoint = isCurrentlyFollowing ? '/unfollow_user' : '/follow_user';

    $btn.addClass('loading').prop('disabled', true);
    $btn.html('<div class="spinner-sm"></div>');

    $.ajax({
        url: endpoint,
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ username: username }),
        success(response) {
            $btn.removeClass('loading').prop('disabled', false);
            if (response.success) {
                if (action === 'follow') {
                    myFollowingSet.add(uLower);
                    showToast(`Followed @${username}`, 'success', 2500);
                } else {
                    myFollowingSet.delete(uLower);
                    showToast(`Unfollowed @${username}`, 'info', 2500);
                }
                updateAllButtonsForUser(username);
                updateFollowToolbarStats();
            } else {
                updateAllButtonsForUser(username);
                showToast(response.message || `Error during ${action}`, 'error', 5500);
            }
        },
        error(xhr) {
            $btn.removeClass('loading').prop('disabled', false);
            updateAllButtonsForUser(username);
            let errMsg = 'Network error.';
            try { errMsg = JSON.parse(xhr.responseText).message || errMsg; } catch(e) {}
            showToast(errMsg, 'error', 4500);
        }
    });
}

function updateAllButtonsForUser(username) {
    const uLower = username.toLowerCase();
    const isFollowing = myFollowingSet.has(uLower);
    $(`button.follow-btn[data-username="${username}"]`).each(function() {
        const btn = $(this);
        btn.toggleClass('following', isFollowing);
        btn.attr('title', isFollowing ? `Click to Unfollow @${username}` : `Click to Follow @${username}`);
        btn.html(isFollowing ? '<i data-lucide="check"></i> <span>Following</span>' : '<i data-lucide="user-plus"></i> <span>Follow</span>');
    });
    lucide.createIcons();
}

function checkFollowingStatus(showToasts = true) {
    const btn = $('#btnCheckFollowing');
    btn.prop('disabled', true).html('<i data-lucide="loader-2" class="spin"></i> Checking…');
    lucide.createIcons();

    $.ajax({
        url: '/get_following_list',
        type: 'GET',
        success(response) {
            btn.prop('disabled', false).html('<i data-lucide="refresh-cw"></i> Check Follow Status');
            if (response.success) {
                myFollowingSet = new Set((response.following || []).map(u => u.toLowerCase()));
                followingLoaded = true;

                // Update all buttons in DOM
                $('button.follow-btn').each(function() {
                    const u = $(this).attr('data-username');
                    if (u) {
                        const isFollowing = myFollowingSet.has(u.toLowerCase());
                        $(this).toggleClass('following', isFollowing);
                        $(this).attr('title', isFollowing ? `Click to Unfollow @${u}` : `Click to Follow @${u}`);
                        $(this).html(isFollowing ? '<i data-lucide="check"></i> <span>Following</span>' : '<i data-lucide="user-plus"></i> <span>Follow</span>');
                    }
                });
                lucide.createIcons();
                updateFollowToolbarStats();
                if (showToasts) {
                    showToast(`Follow status synced! You follow ${response.total_following} accounts.`, 'success');
                }
            } else {
                if (showToasts) {
                    showToast(response.message || 'Error checking following list.', 'warning');
                }
            }
        },
        error() {
            btn.prop('disabled', false).html('<i data-lucide="refresh-cw"></i> Check Follow Status');
            lucide.createIcons();
            if (showToasts) {
                showToast('Failed to connect to GitHub following endpoint.', 'error');
            }
        }
    });
}

function updateFollowToolbarStats() {
    const card = document.getElementById('followManagerCard');
    if (!card) return;

    const visibleUsernames = getVisibleUsernames();
    if (!visibleUsernames.length) {
        card.style.display = 'none';
        return;
    }

    card.style.display = 'block';
    $('#followBadgeCount').text(`${visibleUsernames.length} Profiles`);

    let followingCount = 0;
    let notFollowingCount = 0;
    visibleUsernames.forEach(u => {
        if (myFollowingSet.has(u.toLowerCase())) {
            followingCount++;
        } else {
            notFollowingCount++;
        }
    });

    $('#statFollowingCount').text(followingCount);
    $('#statNotFollowingCount').text(notFollowingCount);
    $('#btnFollowAll').html(`<i data-lucide="user-plus"></i> Follow All (${notFollowingCount})`).prop('disabled', notFollowingCount === 0);
    $('#btnUnfollowAll').html(`<i data-lucide="user-minus"></i> Unfollow All (${followingCount})`).prop('disabled', followingCount === 0);
    lucide.createIcons();
}

function getVisibleUsernames() {
    const usernames = [];
    const seen = new Set();
    const rows = fullTableData;
    if (!rows || !rows.length) return [];

    const profileCol = fullTableColumns.find(c => c === 'GitHub Profiles' || c.toLowerCase().includes('profile') || c.toLowerCase() === 'github');
    if (!profileCol) return [];

    rows.forEach(r => {
        const val = r[profileCol];
        const u = extractGitHubUsername(val);
        if (u && !seen.has(u.toLowerCase())) {
            seen.add(u.toLowerCase());
            usernames.push(u);
        }
    });
    return usernames;
}

function startBatchFollow(action) {
    const visibleUsernames = getVisibleUsernames();
    const targetUsernames = action === 'follow'
        ? visibleUsernames.filter(u => !myFollowingSet.has(u.toLowerCase()))
        : visibleUsernames.filter(u => myFollowingSet.has(u.toLowerCase()));

    if (!targetUsernames.length) {
        showToast(`No profiles need to be ${action}ed!`, 'info');
        return;
    }

    if (action === 'unfollow' && !confirm(`Are you sure you want to unfollow ${targetUsernames.length} student profiles?`)) {
        return;
    }

    $('#btnFollowAll').prop('disabled', true);
    $('#btnUnfollowAll').prop('disabled', true);
    $('#btnCheckFollowing').prop('disabled', true);
    $('#btnStopBatchFollow').show();
    $('#followProgressBarWrap').show();
    $('#followProgressFill').css('width', '0%');
    $('#followProgressText').text(`Starting batch ${action} for ${targetUsernames.length} users...`);

    $.ajax({
        url: '/batch_follow',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ action: action, usernames: targetUsernames }),
        success(response) {
            if (response.success) {
                showToast(response.message, 'info');
                pollBatchFollowStatus(action);
            } else {
                endBatchFollow();
                showToast(response.message || `Error starting ${action}`, 'error');
            }
        },
        error(xhr) {
            endBatchFollow();
            let msg = `Error starting batch ${action}`;
            try { msg = JSON.parse(xhr.responseText).message || msg; } catch(e) {}
            showToast(msg, 'error');
        }
    });
}

function pollBatchFollowStatus(action) {
    if (batchFollowPollTimer) clearInterval(batchFollowPollTimer);

    batchFollowPollTimer = setInterval(function() {
        $.get('/batch_follow_status', function(data) {
            if (!data) return;

            const pct = data.total > 0 ? Math.min(100, Math.round((data.current / data.total) * 100)) : 0;
            $('#followProgressFill').css('width', pct + '%');
            $('#followProgressText').text(data.message || `Processing ${data.current} / ${data.total}...`);

            if (data.results) {
                Object.entries(data.results).forEach(([u, res]) => {
                    const uLower = u.toLowerCase();
                    if (res === 'following') {
                        myFollowingSet.add(uLower);
                        updateAllButtonsForUser(u);
                    } else if (res === 'not_following') {
                        myFollowingSet.delete(uLower);
                        updateAllButtonsForUser(u);
                    }
                });
                updateFollowToolbarStats();
            }

            if (!data.in_progress) {
                clearInterval(batchFollowPollTimer);
                batchFollowPollTimer = null;
                endBatchFollow();
                showToast(data.message || `Batch ${action} completed!`, 'success', 5000);
            }
        });
    }, 400);
}

function stopBatchFollow() {
    $.post('/stop_batch_follow', function() {
        showToast('Stopping batch operation…', 'info');
    });
}

function endBatchFollow() {
    $('#btnStopBatchFollow').hide();
    $('#btnFollowAll').prop('disabled', false);
    $('#btnUnfollowAll').prop('disabled', false);
    $('#btnCheckFollowing').prop('disabled', false);
    setTimeout(() => {
        $('#followProgressBarWrap').fadeOut();
    }, 3500);
    updateFollowToolbarStats();
}

// ─── ON LOAD ────────────────────────────────────────
$(document).ready(function () {
    initTheme();
    checkRateLimit();

    // Clear stale localStorage so file must be re-uploaded
    localStorage.removeItem('selectedSheet');
    localStorage.removeItem('uploadedFilePath');
});
