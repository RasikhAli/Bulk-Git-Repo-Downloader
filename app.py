import os
import pandas as pd
import requests
import shutil
from flask import Flask, render_template, request, jsonify, send_file, Response
import zipfile
import threading
import time

app = Flask(__name__)

UPLOAD_FOLDER = "uploads"
DOWNLOAD_FOLDER = "downloads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)

uploaded_file_path = None
progress_data = {"total": 0, "completed": 0, "message": ""}


@app.route("/")
def index():
    return render_template("index.html")


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

        data = df.to_dict(orient="records")
        columns = df.columns.tolist()

        return jsonify({"success": True, "data": data, "columns": columns})
    except Exception as e:
        return jsonify({"success": False, "message": f"Error loading sheet: {str(e)}"})


def download_repo(sheet, reg_no, name, repo_url):
    global progress_data
    zip_url = repo_url + "/archive/refs/heads/main.zip"
    zip_file_name = f"{sheet} - {reg_no} - {name}.zip"
    zip_path = os.path.join(DOWNLOAD_FOLDER, zip_file_name)
    try:
        response = requests.get(zip_url, stream=True, timeout=30)
        if response.status_code == 200:
            with open(zip_path, "wb") as file:
                shutil.copyfileobj(response.raw, file)
            extract_dir = os.path.join(DOWNLOAD_FOLDER, zip_file_name.replace(".zip", ""))
            os.makedirs(extract_dir, exist_ok=True)
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(extract_dir)
            os.remove(zip_path)
        else:
            print(f"Failed to download: {repo_url}")
    except Exception as e:
        print(f"Error downloading {repo_url}: {e}")

    # Update progress
    progress_data["completed"] += 1
    progress_data["message"] = f"Processed {progress_data['completed']} / {progress_data['total']}"


@app.route("/download_repos", methods=["POST"])
def download_repos():
    global uploaded_file_path, progress_data
    if not uploaded_file_path:
        return jsonify({"success": False, "message": "No file uploaded."})

    sheet_name = request.json.get("sheet_name")
    xls = pd.ExcelFile(uploaded_file_path)

    try:
        sheets = xls.sheet_names if sheet_name == "All" else [sheet_name]
        jobs = []

        for sheet in sheets:
            df = pd.read_excel(xls, sheet_name=sheet, skiprows=11)
            df = df[['Reg No', 'Name', 'GitHub Repo']].dropna()
            for _, row in df.iterrows():
                reg_no = str(row['Reg No'])
                name = str(row['Name']).replace("/", "-").replace("\\", "-")
                repo_url = str(row['GitHub Repo']).strip()
                if repo_url.startswith("http"):
                    jobs.append((sheet, reg_no, name, repo_url))

        progress_data = {"total": len(jobs), "completed": 0, "message": "Starting..."}

        def run_jobs():
            for job in jobs:
                download_repo(*job)
            progress_data["message"] = "All downloads complete!"

        threading.Thread(target=run_jobs).start()
        return jsonify({"success": True, "message": f"Started downloading {len(jobs)} repos."})

    except Exception as e:
        return jsonify({"success": False, "message": f"Error: {str(e)}"})


@app.route("/progress")
def progress():
    def generate():
        while progress_data["completed"] < progress_data["total"]:
            yield f"data: {progress_data['completed']},{progress_data['total']},{progress_data['message']}\n\n"
            time.sleep(1)
        yield f"data: {progress_data['completed']},{progress_data['total']},{progress_data['message']}\n\n"

    return Response(generate(), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(debug=True, threaded=True)
