import os
import ast as python_ast
import difflib
import hashlib
import warnings
from dotenv import load_dotenv

load_dotenv()

import pandas as pd
import requests
import shutil
from flask import Flask, render_template, request, jsonify, Response
import zipfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

app = Flask(__name__)

UPLOAD_FOLDER = "uploads"
DOWNLOAD_FOLDER = "downloads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)

uploaded_file_path = None
progress_data = {"total": 0, "completed": 0, "message": ""}
progress_lock = threading.Lock()

# Download summary tracking
download_summary = []
summary_lock = threading.Lock()

# Configuration for performance
MAX_WORKERS = 10  # Number of concurrent downloads
GITHUB_API_CACHE = {}  # Simple in-memory cache for GitHub API responses
CACHE_EXPIRY = 300  # Cache expiry in seconds (5 minutes)

# GitHub API Token - Set this for higher rate limits (5000/hr vs 60/hr)
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '')

# Create a session for connection pooling
session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=3)
session.mount('http://', adapter)
session.mount('https://', adapter)

if GITHUB_TOKEN:
    session.headers.update({'Authorization': f'token {GITHUB_TOKEN}'})
    print("[SUCCESS] GitHub token configured - 5000 requests/hour limit")
else:
    print("[WARNING] No GitHub token - limited to 60 requests/hour. Set GITHUB_TOKEN env variable.")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/set_github_token", methods=["POST"])
def set_github_token():
    """Set GitHub token for API requests"""
    global GITHUB_TOKEN
    token = request.json.get("token", "").strip()

    if token:
        GITHUB_TOKEN = token
        session.headers.update({'Authorization': f'token {token}'})
        try:
            test_resp = session.get("https://api.github.com/rate_limit", timeout=5)
            if test_resp.status_code == 200:
                rate_info = test_resp.json()
                remaining = rate_info['resources']['core']['remaining']
                limit = rate_info['resources']['core']['limit']
                return jsonify({
                    "success": True,
                    "message": f"Token valid! Rate limit: {remaining}/{limit} requests remaining"
                })
            else:
                GITHUB_TOKEN = ''
                session.headers.pop('Authorization', None)
                return jsonify({"success": False, "message": "Invalid token"})
        except Exception as e:
            return jsonify({"success": False, "message": f"Error testing token: {str(e)}"})
    else:
        GITHUB_TOKEN = ''
        session.headers.pop('Authorization', None)
        return jsonify({"success": True, "message": "Token cleared"})


@app.route("/check_rate_limit", methods=["GET"])
def check_rate_limit():
    """Check GitHub API rate limit status"""
    try:
        resp = session.get("https://api.github.com/rate_limit", timeout=5)
        if resp.status_code == 200:
            rate_info = resp.json()
            core = rate_info['resources']['core']
            return jsonify({
                "success": True,
                "limit": core['limit'],
                "remaining": core['remaining'],
                "reset": core['reset'],
                "has_token": bool(GITHUB_TOKEN)
            })
        return jsonify({"success": False, "message": "Could not check rate limit"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


@app.route("/upload", methods=["POST"])
def upload_file():
    global uploaded_file_path
    file = request.files["file"]
    if file and file.filename.endswith((".xls", ".xlsx")):
        uploaded_file_path = os.path.join(UPLOAD_FOLDER, file.filename)
        file.save(uploaded_file_path)
        xls = pd.ExcelFile(uploaded_file_path)
        return jsonify({"success": True, "sheets": ["All"] + xls.sheet_names, "file_path": uploaded_file_path})
    return jsonify({"success": False, "message": "Invalid file format."})


@app.route("/load_sheet", methods=["POST"])
def load_sheet():
    global uploaded_file_path
    if not uploaded_file_path:
        return jsonify({"success": False, "message": "No file uploaded."})

    sheet_name = request.json.get("sheet_name")
    try:
        xls = pd.ExcelFile(uploaded_file_path)
        if sheet_name == "All":
            dfs = []
            for sheet in xls.sheet_names:
                df = pd.read_excel(xls, sheet_name=sheet, header=11)
                df["Tab Name"] = sheet
                dfs.append(df)
            df = pd.concat(dfs, ignore_index=True)
        else:
            df = pd.read_excel(xls, sheet_name=sheet_name, header=11)

        df = df.loc[:, ~df.columns.str.contains("^Unnamed")]
        columns_to_remove = [f"Week-{i}" for i in range(1, 15)] + ["Tasks", "W", "X", "Y"]
        df = df.drop(columns=[col for col in columns_to_remove if col in df.columns], errors="ignore")
        df = df.dropna(how="all").fillna("").astype(str)
        df = df[df.iloc[:, 0].astype(str).str.strip() != ""]

        unwanted_keywords = ["Grade Total", "Total"]
        grade_keywords = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"]

        def is_summary_row(row):
            row_str = row.iloc[:5].astype(str).str.strip()
            return (row_str.isin(unwanted_keywords + grade_keywords).any() or
                    (row_str.str.len().sum() < 10 and row_str.isin(grade_keywords).any()))

        df = df[~df.apply(is_summary_row, axis=1)]
        df.insert(0, "#", range(1, len(df) + 1))

        data = df.to_dict(orient="records")
        columns = df.columns.tolist()

        github_profiles_info = []
        if 'GitHub Profiles' in columns:
            for _, row in df.iterrows():
                profile_url = str(row.get('GitHub Profiles', '')).strip()
                if profile_url and profile_url.startswith('http'):
                    github_profiles_info.append({
                        'reg_no': str(row.get('Reg No', '')),
                        'name': str(row.get('Name', '')),
                        'profile_url': profile_url
                    })

        has_github_repo = 'GitHub Repo' in columns
        has_github_project_repo = 'GitHub Project Repo' in columns

        return jsonify({
            "success": True,
            "data": data,
            "columns": columns,
            "github_profiles_info": github_profiles_info,
            "has_github_repo": has_github_repo,
            "has_github_project_repo": has_github_project_repo
        })
    except Exception as e:
        return jsonify({"success": False, "message": f"Error loading sheet: {str(e)}"})


def download_repo_fast(args):
    """Fast download function with summary tracking"""
    sheet, reg_no, name, repo_url, source_type = args

    repo_url = repo_url.rstrip('/').removesuffix('.git').rstrip('/')
    branches = ['main', 'master']

    safe_name = "".join(c for c in name if c.isalnum() or c in (' ', '-', '_')).strip()
    safe_reg_no = "".join(c for c in reg_no if c.isalnum() or c in ('-', '_')).strip()
    zip_file_name = f"{sheet} - {safe_reg_no} - {safe_name} - {source_type}.zip"
    zip_path = os.path.join(DOWNLOAD_FOLDER, zip_file_name)

    summary_entry = {
        "sheet": sheet,
        "reg_no": reg_no,
        "name": name,
        "repo_url": repo_url,
        "source_type": source_type,
        "status": "failed",
        "branch": None,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
    }

    for branch in branches:
        zip_url = f"{repo_url}/archive/refs/heads/{branch}.zip"
        try:
            print(f"Trying: {zip_url}")
            response = session.get(zip_url, stream=True, timeout=30)
            print(f"Response: {response.status_code}")
            if response.status_code == 200:
                with open(zip_path, "wb") as file:
                    shutil.copyfileobj(response.raw, file)
                extract_dir = os.path.join(DOWNLOAD_FOLDER, zip_file_name.replace(".zip", ""))
                os.makedirs(extract_dir, exist_ok=True)
                with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                    zip_ref.extractall(extract_dir)
                os.remove(zip_path)
                print(f"✓ Downloaded: {safe_reg_no} - {safe_name}")
                summary_entry["status"] = "success"
                summary_entry["branch"] = branch
                with summary_lock:
                    download_summary.append(summary_entry)
                return True
        except Exception as e:
            print(f"Error downloading {repo_url} ({branch}): {e}")
            continue

    print(f"✗ Failed to download: {repo_url}")
    with summary_lock:
        download_summary.append(summary_entry)
    return False


@app.route("/download_repos", methods=["POST"])
def download_repos():
    global uploaded_file_path, progress_data, download_summary
    if not uploaded_file_path:
        return jsonify({"success": False, "message": "No file uploaded."})

    sheet_name = request.json.get("sheet_name")
    xls = pd.ExcelFile(uploaded_file_path)

    # Reset summary for this run
    with summary_lock:
        download_summary = []

    try:
        sheets = xls.sheet_names if sheet_name == "All" else [sheet_name]
        jobs = []

        for sheet in sheets:
            df = pd.read_excel(xls, sheet_name=sheet, skiprows=11)
            print(f"Sheet '{sheet}' columns: {df.columns.tolist()}")

            repo_columns = []
            if 'GitHub Repo' in df.columns:
                repo_columns.append('GitHub Repo')
            if 'GitHub Project Repo' in df.columns:
                repo_columns.append('GitHub Project Repo')

            if not repo_columns:
                print(f"No repo columns found in sheet '{sheet}'")
                continue

            for _, row in df.iterrows():
                reg_no = str(row.get('Reg No', '')).strip()
                name = str(row.get('Name', '')).strip().replace("/", "-").replace("\\", "-")

                if not reg_no or not name or reg_no == 'nan' or name == 'nan':
                    continue

                for repo_col in repo_columns:
                    repo_url = str(row.get(repo_col, '')).strip()
                    if repo_url and repo_url.startswith("http") and repo_url != 'nan':
                        jobs.append((sheet, reg_no, name, repo_url, repo_col))

        print(f"Total jobs to download: {len(jobs)}")

        if len(jobs) == 0:
            return jsonify({"success": False, "message": "No valid repository URLs found in the sheet."})

        with progress_lock:
            progress_data = {"total": len(jobs), "completed": 0, "message": "Starting..."}

        def run_parallel_jobs():
            global progress_data
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                futures = {executor.submit(download_repo_fast, job): job for job in jobs}
                for future in as_completed(futures):
                    result = future.result()
                    with progress_lock:
                        progress_data["completed"] += 1
                        status = "✓" if result else "✗"
                        progress_data["message"] = f"{status} Processed {progress_data['completed']} / {progress_data['total']}"
            with progress_lock:
                progress_data["message"] = "All downloads complete!"

        threading.Thread(target=run_parallel_jobs).start()
        return jsonify({"success": True, "message": f"Started downloading {len(jobs)} repos with {MAX_WORKERS} parallel workers."})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": f"Error: {str(e)}"})


# Rate limiting for GitHub API
api_request_lock = threading.Lock()
last_api_request_time = 0
API_REQUEST_DELAY = 0.1


def get_github_repos_cached(profile_url, limit=5):
    """Fetch top repositories from a GitHub profile with caching and rate limiting"""
    global GITHUB_API_CACHE, last_api_request_time

    cache_key = f"{profile_url}_{limit}"
    current_time = time.time()

    if cache_key in GITHUB_API_CACHE:
        cached_data, cache_time = GITHUB_API_CACHE[cache_key]
        if current_time - cache_time < CACHE_EXPIRY:
            return cached_data

    try:
        if profile_url.endswith('/'):
            profile_url = profile_url[:-1]
        username = profile_url.split('/')[-1]

        with api_request_lock:
            elapsed = time.time() - last_api_request_time
            if elapsed < API_REQUEST_DELAY:
                time.sleep(API_REQUEST_DELAY - elapsed)
            last_api_request_time = time.time()

        api_url = f"https://api.github.com/users/{username}/repos"
        params = {
            'sort': 'updated',
            'direction': 'desc',
            'per_page': limit,
            'type': 'owner'
        }

        response = session.get(api_url, params=params, timeout=10)

        if response.status_code == 429:
            retry_after = int(response.headers.get('Retry-After', 60))
            print(f"Rate limited, waiting {retry_after}s...")
            time.sleep(min(retry_after, 5))
            response = session.get(api_url, params=params, timeout=10)

        if response.status_code == 200:
            repos = response.json()
            result = [{
                'name': repo['name'],
                'url': repo['html_url'],
                'description': repo['description'] or 'No description',
                'updated_at': repo['updated_at'],
                'stars': repo.get('stargazers_count', 0),
                'language': repo.get('language', 'Unknown'),
                'fork': repo.get('fork', False),
                'forks_count': repo.get('forks_count', 0),
            } for repo in repos]

            GITHUB_API_CACHE[cache_key] = (result, current_time)
            return result
        elif response.status_code == 403:
            remaining = response.headers.get('X-RateLimit-Remaining', '?')
            print(f"GitHub API forbidden for {username}. Remaining: {remaining}")
            return []
        else:
            print(f"Failed to fetch repos for {username}: {response.status_code}")
            return []
    except Exception as e:
        print(f"Error fetching repos for {profile_url}: {e}")
        return []


def fetch_single_profile(profile_info):
    """Fetch repos for a single profile"""
    repos = get_github_repos_cached(profile_info['profile_url'])
    return {
        'reg_no': profile_info['reg_no'],
        'name': profile_info['name'],
        'profile_url': profile_info['profile_url'],
        'repositories': repos
    }


@app.route("/fetch_profiles", methods=["POST"])
def fetch_profiles():
    """Lazy-load GitHub profiles"""
    profiles_info = request.json.get("profiles", [])

    if not profiles_info:
        return jsonify({"success": False, "message": "No profiles provided."})

    github_profiles_data = []
    max_workers = 3 if GITHUB_TOKEN else 1

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(fetch_single_profile, p): p for p in profiles_info}
        for future in as_completed(futures):
            try:
                result = future.result()
                if result['repositories']:
                    github_profiles_data.append(result)
            except Exception as e:
                print(f"Error fetching profile: {e}")

    return jsonify({
        "success": True,
        "github_profiles": github_profiles_data,
        "message": f"Fetched {len(github_profiles_data)} profiles with repos" +
                   (" (some may have failed due to rate limits)" if not GITHUB_TOKEN else "")
    })


@app.route("/download_progress_status", methods=["GET"])
def download_progress_status():
    """Real-time JSON endpoint for download progress (reliable polling fallback)."""
    with progress_lock:
        return jsonify(dict(progress_data))


@app.route("/progress")
def progress():
    def generate():
        last_str = None
        for _ in range(900):  # Keep alive up to 6 minutes
            with progress_lock:
                c = progress_data.get("completed", 0)
                t = progress_data.get("total", 0)
                m = progress_data.get("message", "Starting...")
            data_str = f"{c},{t},{m}"
            if data_str != last_str:
                last_str = data_str
                yield f"data: {data_str}\n\n"
            if t > 0 and c >= t:
                yield f"data: {c},{t},All downloads complete!\n\n"
                break
            time.sleep(0.4)

    return Response(generate(), mimetype="text/event-stream")


@app.route("/download_selected_repos", methods=["POST"])
def download_selected_repos():
    global progress_data, download_summary

    selected_repos = request.json.get("selected_repos", [])
    if not selected_repos:
        return jsonify({"success": False, "message": "No repositories selected."})

    # Reset summary for this run
    with summary_lock:
        download_summary = []

    with progress_lock:
        progress_data = {"total": len(selected_repos), "completed": 0, "message": "Starting..."}

    def run_selective_jobs():
        global progress_data
        jobs = []
        for repo_data in selected_repos:
            reg_no = repo_data['reg_no']
            name = repo_data['name'].replace("/", "-").replace("\\", "-")
            repo_url = repo_data['repo_url']
            repo_name = repo_data['repo_name']
            jobs.append(("Selected", reg_no, name, repo_url, f"Selected-{repo_name}"))

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(download_repo_fast, job): job for job in jobs}
            for _ in as_completed(futures):
                with progress_lock:
                    progress_data["completed"] += 1
                    progress_data["message"] = f"Processed {progress_data['completed']} / {progress_data['total']}"

        with progress_lock:
            progress_data["message"] = "All selective downloads complete!"

    threading.Thread(target=run_selective_jobs).start()
    return jsonify({"success": True, "message": f"Started downloading {len(selected_repos)} selected repos."})


# ─── DOWNLOAD SUMMARY ────────────────────────────────────────────────────────

@app.route("/get_summary", methods=["GET"])
def get_summary():
    """Return the download summary as JSON"""
    with summary_lock:
        summary = list(download_summary)

    if not summary:
        return jsonify({"success": False, "message": "No download summary available. Run a download first."})

    succeeded = [e for e in summary if e["status"] == "success"]
    failed = [e for e in summary if e["status"] == "failed"]

    return jsonify({
        "success": True,
        "total": len(summary),
        "succeeded": len(succeeded),
        "failed": len(failed),
        "success_rate": round((len(succeeded) / len(summary)) * 100, 1) if summary else 0,
        "entries": summary
    })


@app.route("/export_summary_csv", methods=["GET"])
def export_summary_csv():
    """Export download summary as a CSV file"""
    with summary_lock:
        summary = list(download_summary)

    if not summary:
        return jsonify({"success": False, "message": "No summary to export."})

    import io
    output = io.StringIO()
    output.write("Sheet,Reg No,Name,Repo URL,Source Type,Status,Branch,Timestamp\n")
    for entry in summary:
        row = [
            entry.get("sheet", ""),
            entry.get("reg_no", ""),
            entry.get("name", ""),
            entry.get("repo_url", ""),
            entry.get("source_type", ""),
            entry.get("status", ""),
            entry.get("branch", "") or "",
            entry.get("timestamp", "")
        ]
        output.write(",".join(f'"{v}"' for v in row) + "\n")

    csv_content = output.getvalue()
    return Response(
        csv_content,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=download_summary.csv"}
    )


# ─── PLAGIARISM / COPY DETECTION ─────────────────────────────────────────────
from plagiarism_engine import run_plagiarism_analysis, generate_excel_report, set_progress_callback

latest_plagiarism_data = {
    "similarities": [],
    "total_repos": 0,
    "total_pairs": 0,
    "suspicious_pairs": 0
}
plagiarism_in_progress = False
plagiarism_progress = {"current": 0, "total": 100, "message": "Ready", "percent": 0}

def update_progress(current, total, message):
    global plagiarism_progress
    pct = round((current / total * 100), 1) if total > 0 else 0
    plagiarism_progress = {
        "current": current,
        "total": total,
        "message": message,
        "percent": min(100, int(pct))
    }

set_progress_callback(update_progress)


@app.route("/check_plagiarism", methods=["GET"])
def check_plagiarism():
    global latest_plagiarism_data, plagiarism_in_progress, plagiarism_progress
    
    if plagiarism_in_progress:
        return jsonify({"success": False, "message": "Analysis already in progress", "in_progress": True})
    
    plagiarism_in_progress = True
    plagiarism_progress = {"current": 1, "total": 100, "message": "Scanning downloaded repositories...", "percent": 1}
    
    def run_in_background():
        global latest_plagiarism_data, plagiarism_in_progress, plagiarism_progress
        try:
            result = run_plagiarism_analysis(DOWNLOAD_FOLDER)
            if result.get("success"):
                latest_plagiarism_data = {
                    "similarities": result.get("similarities", []),
                    "total_repos": result.get("total_repos", 0),
                    "total_pairs": result.get("total_pairs", 0),
                    "suspicious_pairs": result.get("suspicious_pairs", 0)
                }
            print(f"[PLAGIARISM] Background analysis complete: {len(latest_plagiarism_data['similarities'])} results")
        except Exception as e:
            print(f"[PLAGIARISM] Error: {e}")
        finally:
            plagiarism_in_progress = False
            plagiarism_progress = {"current": 100, "total": 100, "message": "Analysis complete!", "percent": 100}
    
    threading.Thread(target=run_in_background, daemon=True).start()
    return jsonify({"success": True, "message": "Analysis started in background", "in_progress": True})


@app.route("/plagiarism_status", methods=["GET"])
def plagiarism_status():
    global latest_plagiarism_data, plagiarism_in_progress, plagiarism_progress
    return jsonify({
        "in_progress": plagiarism_in_progress,
        "progress": plagiarism_progress,
        "results": latest_plagiarism_data.get("similarities", []),
        "total_repos": latest_plagiarism_data.get("total_repos", 0),
        "total_pairs": latest_plagiarism_data.get("total_pairs", 0),
        "suspicious_pairs": latest_plagiarism_data.get("suspicious_pairs", 0)
    })


@app.route("/export_plagiarism_excel", methods=["GET"])
def export_plagiarism_excel():
    global latest_plagiarism_data
    sims = latest_plagiarism_data.get("similarities", [])
    if not sims:
        return jsonify({"success": False, "message": "No plagiarism results generated yet."})

    report_bytes, error = generate_excel_report(sims)
    if error:
        return jsonify({"success": False, "message": f"Server error: {error}. Try '$ pip install xlsxwriter'"})
        
    return Response(
        report_bytes,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=Plagiarism_Report.xlsx"}
    )


if __name__ == "__main__":
    app.run(debug=True, threaded=True)
