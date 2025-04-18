import os
import pandas as pd
import requests
import shutil
from flask import Flask, render_template, request, jsonify, send_file

app = Flask(__name__)

UPLOAD_FOLDER = "uploads"
DOWNLOAD_FOLDER = "downloads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)

uploaded_file_path = None  # Store the uploaded file path globally

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
                df["Tab Name"] = sheet  # Add sheet name as a new column
                dfs.append(df)

            df = pd.concat(dfs, ignore_index=True)
        else:
            df = pd.read_excel(xls, sheet_name=sheet_name, header=11)
        
        if not isinstance(df, pd.DataFrame) or df.empty:
            raise ValueError("Invalid sheet name or empty sheet.")

        # **Remove "Unnamed" columns automatically**
        df = df.loc[:, ~df.columns.str.contains("^Unnamed")]

        # List of columns to exclude
        columns_to_remove = [f"Week-{i}" for i in range(1, 15)] + ["Tasks", "W", "X", "Y"]
        df = df.drop(columns=[col for col in columns_to_remove if col in df.columns], errors="ignore")

        df = df.dropna(how="all")  # Drop completely empty rows
        df = df.fillna("")  # **Replace NaN with an empty string**
        df = df.astype(str)  # Convert all data to string

        # **Add "#" column as the first column**
        # df.insert(0, "#", range(1, len(df) + 1))

        data = df.to_dict(orient="records")
        columns = df.columns.tolist()

        return jsonify({"success": True, "data": data, "columns": columns})

    except Exception as e:
        return jsonify({"success": False, "message": f"Error loading sheet: {str(e)}"})




@app.route("/download_repos", methods=["POST"])
def download_repos():
    global uploaded_file_path
    if not uploaded_file_path:
        return jsonify({"success": False, "message": "No file uploaded."})

    sheet_name = request.json.get("sheet_name")
    xls = pd.ExcelFile(uploaded_file_path)

    try:
        if sheet_name == "All":
            sheets = xls.sheet_names
        else:
            sheets = [sheet_name]

        for sheet in sheets:
            df = pd.read_excel(xls, sheet_name=sheet, skiprows=11)
            df = df[['Reg No', 'Name', 'GitHub Repo']].dropna()

            for _, row in df.iterrows():
                reg_no = str(row['Reg No'])
                name = str(row['Name']).replace("/", "-").replace("\\", "-")
                repo_url = str(row['GitHub Repo']).strip()

                if repo_url.startswith("http"):
                    zip_url = repo_url + "/archive/refs/heads/main.zip"
                    file_name = f"{sheet} - {reg_no} - {name}.zip"
                    save_path = os.path.join(DOWNLOAD_FOLDER, file_name)

                    try:
                        response = requests.get(zip_url, stream=True)
                        if response.status_code == 200:
                            with open(save_path, "wb") as file:
                                shutil.copyfileobj(response.raw, file)
                        else:
                            print(f"Failed to download: {repo_url}")
                    except Exception as e:
                        print(f"Error downloading {repo_url}: {e}")

        return jsonify({"success": True, "message": "Repositories downloaded!"})

    except Exception as e:
        return jsonify({"success": False, "message": f"Error processing sheets: {str(e)}"})


if __name__ == "__main__":
    app.run(debug=True)
