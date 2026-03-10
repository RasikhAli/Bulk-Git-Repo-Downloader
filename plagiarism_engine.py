import os
import hashlib
import difflib
import warnings
import ast as python_ast
import pandas as pd
import io
from concurrent.futures import ThreadPoolExecutor

# File extensions considered "source code" (skip binaries/assets for meaningful comparison)
SOURCE_EXTENSIONS = {
    '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.cs',
    '.html', '.css', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala',
    '.sh', '.bat', '.sql', '.r', '.m', '.json', '.xml', '.yaml', '.yml',
    '.txt', '.md', '.ipynb'
}

TEXT_EXTS = {'.py', '.js', '.ts', '.java', '.c', '.cpp', '.cs', '.html',
             '.css', '.php', '.rb', '.go', '.txt', '.md', '.sh', '.bat', '.sql'}


class _ASTNormalizer(python_ast.NodeTransformer):
    """Replaces all identifiers with sequential tokens to detect renames."""
    def __init__(self):
        self.name_map = {}
        self.counter = [0]

    def _tok(self, name):
        if name not in self.name_map:
            self.name_map[name] = f'N{self.counter[0]}'
            self.counter[0] += 1
        return self.name_map[name]

    def visit_Name(self, node):             node.id  = self._tok(node.id);  return self.generic_visit(node)
    def visit_arg(self, node):              node.arg = self._tok(node.arg); return self.generic_visit(node)
    def visit_FunctionDef(self, node):      node.name = self._tok(node.name); return self.generic_visit(node)
    def visit_AsyncFunctionDef(self, node): node.name = self._tok(node.name); return self.generic_visit(node)
    def visit_ClassDef(self, node):         node.name = self._tok(node.name); return self.generic_visit(node)
    def visit_Attribute(self, node):        node.attr = self._tok(node.attr); return self.generic_visit(node)
    def visit_Global(self, node):           node.names = [self._tok(n) for n in node.names]; return self.generic_visit(node)
    def visit_Nonlocal(self, node):         node.names = [self._tok(n) for n in node.names]; return self.generic_visit(node)


def _normalize_ast(source: str):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            tree = python_ast.parse(source)
        _ASTNormalizer().visit(tree)
        return python_ast.dump(tree)
    except SyntaxError:
        return None


def hash_file(filepath):
    """Calculate MD5 hash of a file's content"""
    try:
        hasher = hashlib.md5()
        with open(filepath, 'rb') as f:
            while chunk := f.read(65536):
                hasher.update(chunk)
        return hasher.hexdigest()
    except Exception:
        return None


def scan_repo_files(repo_dir):
    """Return {rel_path: hash} and {rel_path: abs_path} for all source files."""
    file_hashes, file_paths = {}, {}
    for root, dirs, files in os.walk(repo_dir):
        dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules', '__pycache__', '.venv', 'venv')]
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in SOURCE_EXTENSIONS:
                continue
            fpath = os.path.join(root, fname)
            h = hash_file(fpath)
            if h:
                rel = os.path.relpath(fpath, repo_dir).replace("\\", "/")
                file_hashes[rel] = h
                file_paths[rel] = fpath
    return file_hashes, file_paths


def process_repo(repo):
    """Parses AST and Text dependencies for an individual repository in O(N)."""
    scan_path = repo['path']
    subdirs = [d for d in os.listdir(scan_path) if os.path.isdir(os.path.join(scan_path, d))]
    if len(subdirs) == 1:
        scan_path = os.path.join(scan_path, subdirs[0])
    fh, fp = scan_repo_files(scan_path)
    
    parsed_ast = {}
    parsed_txt = {}
    
    for rel_path, abs_path in fp.items():
        fname = os.path.basename(rel_path)
        
        # Pre-parse Python ASTs
        if fname.endswith('.py'):
            try:
                src = open(abs_path, 'r', encoding='utf-8', errors='ignore').read()
                na = _normalize_ast(src)
                if na is not None:
                    parsed_ast[fname] = na
            except Exception:
                pass
        
        # Pre-parse Text Files (strip lines/comments, save as Set for fast O(1) comparison)
        ext = os.path.splitext(fname)[1].lower()
        if ext in TEXT_EXTS:
            try:
                lines = set()
                for line in open(abs_path, 'r', encoding='utf-8', errors='ignore'):
                    s = line.strip()
                    if not s or len(s) < 5 or s.startswith(('#', '//', '--', '<!--', '/*', '*')):
                        continue
                    lines.add(s)
                    if len(lines) > 1000:  # Cap at 1000 unique lines per file for speed
                        break
                if lines:
                    parsed_txt[fname] = lines
            except Exception:
                pass

    repo['file_hashes'] = fh
    repo['file_paths'] = fp
    repo['parsed_ast'] = parsed_ast
    repo['parsed_txt'] = parsed_txt
    repo['file_count'] = len(fh)
    repo['scan_path'] = os.path.abspath(scan_path)
    return repo


def run_plagiarism_analysis(download_folder):
    """Runs the 3-layer plagiarism detection logic across all downloaded repositories."""
    if not os.path.exists(download_folder):
        return {"success": False, "message": "No downloads folder found.", "results": []}

    repos = []
    for item in os.listdir(download_folder):
        item_path = os.path.join(download_folder, item)
        if not os.path.isdir(item_path):
            continue
        parts = [p.strip() for p in item.split(' - ')]
        repos.append({
            'folder': item, 'path': item_path,
            'sheet':  parts[0] if len(parts) > 0 else 'Unknown',
            'reg_no': parts[1] if len(parts) > 1 else 'Unknown',
            'name':   parts[2] if len(parts) > 2 else 'Unknown',
            'source': parts[3] if len(parts) > 3 else 'Unknown',
        })

    if len(repos) < 2:
        return {"success": False, "message": f"Need at least 2 repos to compare. Found {len(repos)}.", "results": []}

    # Run disk ops & parsing in parallel
    with ThreadPoolExecutor(max_workers=8) as executor:
        repos = list(executor.map(process_repo, repos))

    similarities = []
    # Very fast O(N^2) memory matching
    for i in range(len(repos)):
        for j in range(i + 1, len(repos)):
            ra, rb = repos[i], repos[j]

            # ── Layer 1: MD5 exact match ──
            ha = set(ra['file_hashes'].values())
            hb = set(rb['file_hashes'].values())
            common_h = (ha & hb) if (ha and hb) else set()
            total_f = max(len(ha), len(hb)) if (ha or hb) else 0
            md5_score = round(len(common_h) / total_f * 100, 1) if total_f else 0

            h2pa = {}
            for p, h in ra['file_hashes'].items():
                h2pa.setdefault(h, p)
            sample_matches = [
                {"file_a": h2pa[h], "file_b": pb}
                for pb, h in rb['file_hashes'].items()
                if h in common_h and h in h2pa
            ][:8]

            # ── Layer 2: AST structure ──
            ast_raw = []
            py_files = set(ra['parsed_ast'].keys()) & set(rb['parsed_ast'].keys())
            seen_files = {m['file_a'] for m in sample_matches}
            for f in py_files:
                na, nb = ra['parsed_ast'][f], rb['parsed_ast'][f]
                # Use quick_ratio for linear O(N) speed instead of full O(N^2)
                score = round(difflib.SequenceMatcher(None, na, nb).quick_ratio() * 100, 1)
                ast_raw.append(score)
                if score >= 25 and f not in seen_files:
                    sample_matches.append({"file_a": f, "file_b": f})
                    seen_files.add(f)
            ast_score = round(sum(ast_raw) / len(ast_raw), 1) if ast_raw else None

            # ── Layer 3: Text similarity ──
            txt_raw = []
            tx_files = list(set(ra['parsed_txt'].keys()) & set(rb['parsed_txt'].keys()))[:20]
            for f in tx_files:
                sa, sb = ra['parsed_txt'][f], rb['parsed_txt'][f]
                # Use blazing fast Jaccard similarity on sets: len(A ∩ B) / len(A ∪ B)
                if sa and sb:
                    jaccard = len(sa & sb) / max(len(sa | sb), 1)
                    score = round(jaccard * 100, 1)
                    txt_raw.append(score)
                    if score >= 25 and f not in seen_files:
                        sample_matches.append({"file_a": f, "file_b": f})
                        seen_files.add(f)
            text_score = round(sum(txt_raw) / len(txt_raw), 1) if txt_raw else None

            # ── Combined score ──
            all_scores = [md5_score]
            if ast_score is not None:  all_scores.append(ast_score)
            if text_score is not None: all_scores.append(text_score)
            combined = round(max(all_scores), 1)

            if combined >= 80:     risk = 'critical'
            elif combined >= 50:   risk = 'high'
            elif combined >= 25:   risk = 'medium'
            else:                  risk = 'low'

            similarities.append({
                'student_a': {'name': ra['name'], 'reg_no': ra['reg_no'],
                              'sheet': ra['sheet'], 'file_count': ra['file_count'], 'scan_path': ra['scan_path']},
                'student_b': {'name': rb['name'], 'reg_no': rb['reg_no'],
                              'sheet': rb['sheet'], 'file_count': rb['file_count'], 'scan_path': rb['scan_path']},
                'md5_score':   md5_score,
                'ast_score':   ast_score,
                'text_score':  text_score,
                'combined_score': combined,
                'risk':        risk,
                'matching_files_md5': len(common_h),
                'ast_comparisons':    len(ast_raw),
                'text_comparisons':   len(txt_raw),
                'sample_matches':     sample_matches,
            })

    similarities.sort(key=lambda x: x['combined_score'], reverse=True)
    suspicious = [s for s in similarities if s['combined_score'] >= 25]

    return {
        "success": True,
        "total_repos": len(repos),
        "total_pairs": len(similarities),
        "suspicious_pairs": len(suspicious),
        "similarities": similarities
    }


def generate_excel_report(latest_results):
    """Generates the bytes for the Excel Plagiarism Report."""
    try:
        output = io.BytesIO()
        data = []

        for s in latest_results:
            # Only export suspicious pairs
            if s['combined_score'] < 25:
                continue
                
            a, b = s['student_a'], s['student_b']
            path_a = "file:///" + a['scan_path'].replace('\\', '/')
            path_b = "file:///" + b['scan_path'].replace('\\', '/')
            
            # If they had exact matching files or AST/Text matches, output a row per file match
            if s['sample_matches']:
                for match in s['sample_matches']:
                    data.append({
                        "Student A Name": a['name'],
                        "Student A Reg No": a['reg_no'],
                        "Student B Name": b['name'],
                        "Student B Reg No": b['reg_no'],
                        "Risk": s['risk'].upper(),
                        "Combined Score (%)": s['combined_score'],
                        "Identical File in A": match['file_a'],
                        "Identical File in B": match['file_b'],
                        "Student A Folder": path_a,
                        "Student B Folder": path_b
                    })
            else:
                data.append({
                    "Student A Name": a['name'],
                    "Student A Reg No": a['reg_no'],
                    "Student B Name": b['name'],
                    "Student B Reg No": b['reg_no'],
                    "Risk": s['risk'].upper(),
                    "Combined Score (%)": s['combined_score'],
                    "Identical File in A": "Similarity < 25%",
                    "Identical File in B": "Similarity < 25%",
                    "Student A Folder": path_a,
                    "Student B Folder": path_b
                })
                
        with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
            if data:
                df = pd.DataFrame(data)
                df.to_excel(writer, sheet_name='Plagiarism Report', index=False)
                worksheet = writer.sheets['Plagiarism Report']
                
                # Add autofilter (Sorting and Filtering)
                (max_row, max_col) = df.shape
                worksheet.autofilter(0, 0, max_row, max_col - 1)
                
                # Set column widths for better readability
                worksheet.set_column(0, max_col - 1, 20)
                worksheet.set_column(6, 7, 45) # Identical files columns wider
            else:
                pd.DataFrame([{"Message": "No suspicious file pairs found"}]).to_excel(writer, sheet_name='Plagiarism', index=False)
        
        return output.getvalue(), None
    except Exception as e:
        return None, str(e)
