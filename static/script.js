function uploadFile() {
    let fileInput = document.getElementById("fileInput").files[0];
    if (!fileInput) {
        alert("Please select a file!");
        return;
    }

    let formData = new FormData();
    formData.append("file", fileInput);

    $.ajax({
        url: "/upload",
        type: "POST",
        data: formData,
        contentType: false,
        processData: false,
        success: function(response) {
            if (response.success) {
                localStorage.setItem("uploadedFilePath", response.file_path); // Save file path
                let sheetSelect = $("#sheetSelect");
                sheetSelect.empty();
                response.sheets.forEach(sheet => {
                    sheetSelect.append(new Option(sheet, sheet));
                });
                $("#sheetSection").show();
            } else {
                alert(response.message);
            }
        }
    });
}

function loadSheet() {
    let sheetName = $("#sheetSelect").val();
    localStorage.setItem("selectedSheet", sheetName); // Store sheet selection

    let filePath = localStorage.getItem("uploadedFilePath");
    if (!filePath) {
        alert("No file uploaded.");
        return;
    }

    $.ajax({
        url: "/load_sheet",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({ sheet_name: sheetName }),
        success: function(response) {
            if (response.success) {
                let columns = response.columns;
                let data = response.data;

                let tableHTML = "<table><thead><tr>";
                columns.forEach(col => {
                    tableHTML += `<th>${col}</th>`;
                });
                tableHTML += "</tr></thead><tbody>";

                data.forEach(row => {
                    tableHTML += "<tr>";
                    columns.forEach(col => {
                        let cellValue = row[col]?.trim() || "";
                        let highlightClass = cellValue === "" ? "class='empty-cell'" : "";
                        tableHTML += `<td ${highlightClass}>${cellValue || ""}</td>`;
                    });
                    tableHTML += "</tr>";
                });

                tableHTML += "</tbody></table>";
                $("#tableContainer").html(tableHTML);
                $("#downloadBtn").show();
            } else {
                alert(response.message);
            }
        }
    });
}


// Restore sheet selection & file path on page load
$(document).ready(function() {
    let savedSheet = localStorage.getItem("selectedSheet");
    let filePath = localStorage.getItem("uploadedFilePath");

    if (filePath) {
        $("#sheetSection").show();
    }

    if (savedSheet) {
        $("#sheetSelect").val(savedSheet);
        loadSheet();
    }
});

function downloadRepos() {
    let sheetName = $("#sheetSelect").val();
    let progressText = $("#progressText");
    let progressBar = $("#progressBar");

    $.ajax({
        url: "/download_repos",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({ sheet_name: sheetName }),
        beforeSend: function () {
            $("#downloadBtn").prop("disabled", true);
            $("#progressSection").show();  // Ensure visibility
            progressText.text("Starting...");
            progressBar.css("width", "0%");
        },
        success: function (response) {
            let results = response.message.split("\n");
            let total = results.length;

            results.forEach((msg, index) => {
                setTimeout(() => {
                    progressText.text(msg);
                    let progress = ((index + 1) / total) * 100;
                    progressBar.animate({ width: progress + "%" }, 200);
                }, index * 1000);
            });
            

            setTimeout(() => {
                alert("Download completed!");
                $("#downloadBtn").prop("disabled", false);
            }, total * 1000);
        },
        error: function () {
            alert("Error downloading repositories.");
            $("#downloadBtn").prop("disabled", false);
        },
    });
}
