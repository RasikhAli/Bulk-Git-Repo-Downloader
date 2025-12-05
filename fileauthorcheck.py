import os
import pandas as pd
from docx import Document
from docx.opc.exceptions import PackageNotFoundError
import zipfile
from datetime import datetime

def extract_docx_metadata(file_path):
    """Extract author and last modified by from a .docx file"""
    try:
        doc = Document(file_path)
        core_props = doc.core_properties
        
        author = core_props.author or "Unknown"
        last_modified_by = core_props.last_modified_by or "Unknown"
        
        return {
            'author': author,
            'last_modified_by': last_modified_by,
            'file_path': file_path
        }
    except (PackageNotFoundError, Exception) as e:
        print(f"Error reading {file_path}: {e}")
        return None

def traverse_downloads_folder():
    """Traverse downloads folder and find all .docx files"""
    downloads_path = r"downloads/1 Checked/4"
    if not os.path.exists(downloads_path):
        print(f"Downloads folder '{downloads_path}' not found!")
        return []
    
    docx_data = []
    
    # Get all base folders (student folders)
    base_folders = [f for f in os.listdir(downloads_path) 
                   if os.path.isdir(os.path.join(downloads_path, f))]
    
    for base_folder in base_folders:
        base_path = os.path.join(downloads_path, base_folder)
        print(f"Processing folder: {base_folder}")
        
        # Traverse all subdirectories
        for root, dirs, files in os.walk(base_path):
            for file in files:
                if file.lower().endswith('.docx') and not file.startswith('~$'):
                    file_path = os.path.join(root, file)
                    metadata = extract_docx_metadata(file_path)
                    
                    if metadata:
                        metadata['base_folder'] = base_folder
                        metadata['file_name'] = file
                        docx_data.append(metadata)
    
    return docx_data

def create_excel_report(docx_data):
    """Create Excel report with sorted data"""
    if not docx_data:
        print("No .docx files found!")
        return
    
    # Create DataFrame
    df = pd.DataFrame(docx_data)
    
    # Sort by author first, then by last_modified_by
    df_sorted = df.sort_values(['author', 'last_modified_by', 'base_folder'])
    
    # Create Excel file with multiple sheets
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    excel_filename = f"docx_author_report_{timestamp}.xlsx"
    
    with pd.ExcelWriter(excel_filename, engine='openpyxl') as writer:
        # Main sheet with all data
        df_sorted.to_excel(writer, sheet_name='All Files', index=False)
        
        # Sheet grouped by author
        author_summary = df.groupby('author').agg({
            'base_folder': 'count',
            'last_modified_by': lambda x: ', '.join(x.unique())
        }).rename(columns={'base_folder': 'file_count', 'last_modified_by': 'unique_modifiers'})
        author_summary.to_excel(writer, sheet_name='By Author')
        
        # Sheet grouped by last modified by
        modifier_summary = df.groupby('last_modified_by').agg({
            'base_folder': 'count',
            'author': lambda x: ', '.join(x.unique())
        }).rename(columns={'base_folder': 'file_count', 'author': 'unique_authors'})
        modifier_summary.to_excel(writer, sheet_name='By Last Modified')
    
    print(f"Excel report created: {excel_filename}")
    print(f"Total .docx files processed: {len(docx_data)}")

def main():
    """Main function to run the author check"""
    print("Starting .docx author check...")
    print("Traversing downloads folder...")
    
    docx_data = traverse_downloads_folder()
    
    if docx_data:
        create_excel_report(docx_data)
        
        # Print summary
        authors = set(item['author'] for item in docx_data)
        modifiers = set(item['last_modified_by'] for item in docx_data)
        
        print(f"\nSummary:")
        print(f"Unique authors found: {len(authors)}")
        print(f"Unique last modified by: {len(modifiers)}")
        print(f"Authors: {', '.join(sorted(authors))}")
        print(f"Last modified by: {', '.join(sorted(modifiers))}")
    else:
        print("No .docx files found in downloads folder.")

if __name__ == "__main__":
    main()