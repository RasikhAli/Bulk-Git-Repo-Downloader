/* ===================================================
   Superior Repo Downloader — script.js
   =================================================== */

let githubProfilesData = [];
let githubProfilesInfo = [];
let fullTableData = [];       // All rows for search filtering
let fullTableColumns = [];
let plagiarismCache = null;   // Cache last plagiarism result

// ─── DARK MODE ──────────────────────────────────────
function initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    document.getElementById('darkModeToggle').textContent = saved === 'dark' ? '☀️' : '🌙';
}

function toggleDarkMode() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    document.getElementById('darkModeToggle').textContent = next === 'dark' ? '☀️' : '🌙';
}

// ─── TOAST NOTIFICATIONS ────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const container = document.getElementById('toastContainer');

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;

    container.appendChild(toast);

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
                statusEl.innerHTML = `✅ Token active (${response.remaining}/${response.limit})`;
                statusEl.className = 'token-status active';
            } else {
                statusEl.innerHTML = `⚠️ No token (${response.remaining}/${response.limit})`;
                statusEl.className = 'token-status warning';
            }
        } else {
            statusEl.innerHTML = '❌ Error';
            statusEl.className = 'token-status error';
        }
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

            if (isEmpty) {
                html += `<td class="empty-cell">—</td>`;
            } else if (isUrl) {
                html += `<td class="url-cell">
                    <a href="${val}" target="_blank" rel="noopener" title="${val}">${truncate(val, 35)}</a>
                    <button class="copy-btn" onclick="copyText('${escapeJs(val)}')" title="Copy URL">📋</button>
                </td>`;
            } else {
                html += `<td>${val}</td>`;
            }
        });
        html += '</tr>';
    });

    html += '</tbody></table>';
    $('#tableContainer').html(html);
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
        return;
    }

    const filtered = fullTableData.filter(row =>
        Object.values(row).some(val => val.toString().toLowerCase().includes(query))
    );

    renderTable(filtered, fullTableColumns);
    updateRowCount(filtered.length, fullTableData.length);
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
                $('#fetchProfilesBtn').text('✅ Profiles Loaded').prop('disabled', true);
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
            <h4>📚 Select Repositories to Download</h4>
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
                <h5>👤 ${profile.name} <span class="reg-no">(${profile.reg_no})</span></h5>
                <a href="${profile.profile_url}" target="_blank" rel="noopener" class="profile-link">🔗 View Profile</a>
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
                        <div class="repo-name">📁 ${repo.name}${forkBadge}</div>
                        <div class="repo-desc">${repo.description}</div>
                        <div class="repo-meta">
                            <span>💻 ${repo.language || 'Unknown'}</span>
                            <span>⭐ ${repo.stars}</span>
                            <span>🍴 ${repo.forks_count || 0}</span>
                            <span>📅 ${new Date(repo.updated_at).toLocaleDateString()}</span>
                        </div>
                    </label>
                </div>`;
        });

        html += '</div></div>';
    });

    container.innerHTML = html;
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
        btn.textContent = `📥 Download Selected Repositories (${checked.length})`;
        summary.style.display = 'block';
        document.getElementById('selectedCount').textContent = checked.length;
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
    const evtSource = new EventSource('/progress');
    evtSource.onmessage = function (event) {
        const [completed, total, message] = event.data.split(',');
        const pct = total > 0 ? (completed / total) * 100 : 0;

        $('#progressBar').css('width', pct + '%');
        $('#progressText').text(message);

        if (parseInt(completed) >= parseInt(total) && parseInt(total) > 0) {
            evtSource.close();
            $('#downloadBtn').prop('disabled', false);
            $('#downloadSelectedBtn').prop('disabled', false);
            $('#toolsRow').show();
            showToast('All downloads complete! 🎉', 'success', 6000);
        }
    };
    evtSource.onerror = function () {
        evtSource.close();
        $('#downloadBtn').prop('disabled', false);
        $('#downloadSelectedBtn').prop('disabled', false);
    };
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
                ? `<span class="row-status-badge success">✓ OK</span>`
                : `<span class="row-status-badge failed">✗ Failed</span>`;
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
                    <button class="copy-btn" onclick="copyText('${escapeJs(e.repo_url)}')" title="Copy">📋</button>
                </td>
            </tr>`;
        });

        html += '</tbody></table></div>';
        document.getElementById('summaryContent').innerHTML = html;
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
    document.getElementById('plagiarismLoadingIndicator').style.display = 'flex';

    $.get('/check_plagiarism', function (response) {
        document.getElementById('plagiarismLoadingIndicator').style.display = 'none';

        if (!response.success) {
            document.getElementById('plagiarismContent').innerHTML =
                `<p style="color:var(--text-muted);padding:20px;text-align:center">${response.message}</p>`;
            return;
        }

        plagiarismCache = response;
        renderPlagiarismResults(response, parseInt(document.getElementById('similarityThreshold').value));
    }).fail(function () {
        document.getElementById('plagiarismLoadingIndicator').style.display = 'none';
        document.getElementById('plagiarismContent').innerHTML =
            '<p style="color:var(--danger);padding:20px">Error running plagiarism check.</p>';
    });

    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyThreshold() {
    if (!plagiarismCache) return;
    const threshold = parseInt(document.getElementById('similarityThreshold').value);
    renderPlagiarismResults(plagiarismCache, threshold);
}

function renderPlagiarismResults(data, threshold = 25) {
    const { total_repos, total_pairs, suspicious_pairs, similarities } = data;
    const filtered = similarities.filter(s => s.combined_score >= threshold);

    const rc = { critical: 0, high: 0, medium: 0, low: 0 };
    similarities.forEach(s => { if (rc[s.risk] !== undefined) rc[s.risk]++; });

    let html = `
    <div class="plag-stats">
        <div class="plag-stat">📁 <strong>${total_repos}</strong> repos scanned</div>
        <div class="plag-stat">🔗 <strong>${total_pairs}</strong> pairs compared</div>
        <div class="plag-stat" style="color:var(--danger)">🚨 <strong>${rc.critical}</strong> Critical ≥80%</div>
        <div class="plag-stat" style="color:var(--warning)">⚠️ <strong>${rc.high}</strong> High 50–79%</div>
        <div class="plag-stat" style="color:var(--info)">🔵 <strong>${rc.medium}</strong> Medium 25–49%</div>
    </div>`;

    if (!filtered.length) {
        html += `<div class="plag-no-results">
            <div style="font-size:48px">✅</div>
            <div style="font-size:16px;margin-top:10px;color:var(--success)">No suspicious pairs above ${threshold}%</div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:6px">All repos look original at this threshold.</div>
        </div>`;
    } else {
        filtered.forEach(s => {
            const a = s.student_a, b = s.student_b;
            const barW = Math.min(s.combined_score, 100);

            // Build 4-layer rows
            const col = v => v >= 80 ? 'var(--danger)' : v >= 50 ? 'var(--warning)' : v >= 25 ? 'var(--info)' : 'var(--text-muted)';
            const bar = (v) => `<div class="layer-bar-bg"><div class="layer-bar-fill" style="width:${Math.min(v,100)}%;background:${col(v)}"></div></div>`;

            const layers = [
                { label: '🔑 MD5 Exact',    score: s.md5_score,  note: `${s.matching_files_md5} identical files` },
                { label: '🌳 AST Structure', score: s.ast_score,  note: s.ast_score != null ? `${s.ast_comparisons} .py files` : 'No Python files matched' },
                { label: '📝 Text Sim.',     score: s.text_score, note: s.text_score != null ? `${s.text_comparisons} files` : 'No text files matched' },
            ];

            let layersHtml = '<div class="layer-list">';
            layers.forEach(l => {
                if (l.score === null || l.score === undefined) {
                    layersHtml += `<div class="layer-row layer-na">
                        <span class="layer-label">${l.label}</span>
                        <span style="grid-column:2/5;color:var(--text-muted)">${l.note}</span>
                    </div>`;
                } else {
                    layersHtml += `<div class="layer-row">
                        <span class="layer-label">${l.label}</span>
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
                        📄 ${s.matching_files_md5} identical file${s.matching_files_md5 !== 1 ? 's' : ''} — expand for evidence
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

            html += `
            <div class="plag-card risk-${s.risk}">
                <div class="plag-header">
                    <div class="plag-students">
                        <strong>${a.name}</strong><span class="plag-vs">vs</span><strong>${b.name}</strong>
                    </div>
                    <span class="risk-badge risk-${s.risk}">${s.risk.toUpperCase()}</span>
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
                    <span>🆔 ${a.reg_no} vs ${b.reg_no}</span>
                    <span>📋 ${a.sheet} vs ${b.sheet}</span>
                    <span>📁 ${a.file_count} files vs ${b.file_count} files</span>
                </div>
                ${matchesHtml}
            </div>`;
        });
    }

    document.getElementById('plagiarismContent').innerHTML = html;
}

function closePlagiarismPanel() {
    document.getElementById('plagiarismPanel').style.display = 'none';
}

// ─── ON LOAD ────────────────────────────────────────
$(document).ready(function () {
    initTheme();
    checkRateLimit();

    // Clear stale localStorage so file must be re-uploaded
    localStorage.removeItem('selectedSheet');
    localStorage.removeItem('uploadedFilePath');
});
