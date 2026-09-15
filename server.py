import os
import json
import urllib.parse
import http.server
import socketserver
import webbrowser
import sys
from pathlib import Path

PORT = 8000
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SRC_DIR = BASE_DIR / "src"
USER_DATA_FILE = DATA_DIR / "user_data.json"

def read_user_data():
    if USER_DATA_FILE.exists():
        try:
            with open(USER_DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error reading user_data.json: {e}")
    return {"categories": {}, "recent": [], "volume": 0.8, "loopMode": "sequential"}

def save_user_data(data):
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(USER_DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"Error saving user_data.json: {e}")
        return False

def get_song_metadata(file_path, relative_path):
    name_without_ext = file_path.stem
    title = name_without_ext
    
    if " - " in name_without_ext:
        parts = name_without_ext.split(" - ", 1)
        title = parts[1].strip()
    elif " _ " in name_without_ext:
        parts = name_without_ext.split(" _ ", 1)
        title = parts[0].strip()
    
    url_path = "data/" + urllib.parse.quote(str(relative_path).replace("\\", "/"))
    folder_name = str(relative_path.parent) if str(relative_path.parent) != "." else "Tất cả"
    
    return {
        "id": str(relative_path).replace("\\", "/"),
        "filename": file_path.name,
        "title": title,
        "url": url_path,
        "size": file_path.stat().st_size,
        "folder": folder_name
    }

SONGS_JSON_FILE = DATA_DIR / "songs.json"

def scan_songs():
    songs = []
    if not DATA_DIR.exists():
        return songs
    
    valid_extensions = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac", ".pm3"}
    
    for file_path in DATA_DIR.rglob("*"):
        if file_path.is_file() and file_path.name not in ["user_data.json", "songs.json"] and file_path.suffix.lower() in valid_extensions:
            rel_path = file_path.relative_to(DATA_DIR)
            song_info = get_song_metadata(file_path, rel_path)
            songs.append(song_info)
            
    songs.sort(key=lambda s: s["title"].lower())

    try:
        with open(SONGS_JSON_FILE, "w", encoding="utf-8") as f:
            json.dump(songs, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error saving songs.json: {e}")

    return songs

class MusicPlayerHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        decoded_path = urllib.parse.unquote(path)
        
        if decoded_path == "/" or decoded_path == "/index.html":
            return str(SRC_DIR / "index.html")
        elif decoded_path == "/favicon.ico":
            fav = DATA_DIR / "logo" / "logo.png"
            if fav.exists():
                return str(fav)
        elif decoded_path.startswith("/src/"):
            rel = decoded_path[5:]
            return str(SRC_DIR / rel)
        elif decoded_path.startswith("/data/"):
            rel = decoded_path[6:]
            return str(DATA_DIR / rel)
        
        possible_src = SRC_DIR / decoded_path.lstrip("/")
        if possible_src.exists() and possible_src.is_file():
            return str(possible_src)
            
        return super().translate_path(path)

    def serve_static_file(self, file_path):
        path = Path(file_path)
        if not path.exists() or not path.is_file():
            self.send_error(404, "File Not Found")
            return

        file_size = path.stat().st_size
        mime_type = "audio/mpeg"
        ext = path.suffix.lower()
        if ext == ".wav":
            mime_type = "audio/wav"
        elif ext == ".ogg":
            mime_type = "audio/ogg"
        elif ext in (".m4a", ".aac"):
            mime_type = "audio/mp4"
        elif ext == ".flac":
            mime_type = "audio/flac"
        elif ext == ".html":
            mime_type = "text/html; charset=utf-8"
        elif ext == ".css":
            mime_type = "text/css; charset=utf-8"
        elif ext == ".js":
            mime_type = "application/javascript; charset=utf-8"
        elif ext == ".png":
            mime_type = "image/png"
        elif ext in (".jpg", ".jpeg"):
            mime_type = "image/jpeg"
        elif ext == ".webp":
            mime_type = "image/webp"
        elif ext == ".svg":
            mime_type = "image/svg+xml"

        range_header = self.headers.get('Range')
        
        if range_header and range_header.startswith('bytes='):
            try:
                bytes_range = range_header[6:].split('-')
                start = int(bytes_range[0]) if bytes_range[0] else 0
                end = int(bytes_range[1]) if len(bytes_range) > 1 and bytes_range[1] else file_size - 1
                
                if start >= file_size or end >= file_size or start > end:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{file_size}')
                    self.end_headers()
                    return

                chunk_size = end - start + 1
                self.send_response(206)
                self.send_header('Content-Type', mime_type)
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                self.send_header('Content-Length', str(chunk_size))
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()

                with open(path, 'rb') as f:
                    f.seek(start)
                    remaining = chunk_size
                    buffer_size = 64 * 1024
                    while remaining > 0:
                        read_bytes = min(remaining, buffer_size)
                        buf = f.read(read_bytes)
                        if not buf:
                            break
                        self.wfile.write(buf)
                        remaining -= len(buf)
                return
            except (ConnectionResetError, BrokenPipeError):
                return
            except Exception:
                pass

        self.send_response(200)
        self.send_header('Content-Type', mime_type)
        self.send_header('Content-Length', str(file_size))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        try:
            with open(path, 'rb') as f:
                buffer_size = 64 * 1024
                while True:
                    buf = f.read(buffer_size)
                    if not buf:
                        break
                    self.wfile.write(buf)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/songs":
            songs = scan_songs()
            content = json.dumps(songs, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        elif parsed.path == "/api/user-data":
            user_data = read_user_data()
            content = json.dumps(user_data, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
            
        file_path = self.translate_path(self.path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            file_size = os.path.getsize(file_path)
            self.send_response(200)
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
        else:
            self.send_error(404, "File Not Found")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/songs":
            songs = scan_songs()
            content = json.dumps(songs, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(content)
            return
        elif parsed.path == "/api/user-data":
            user_data = read_user_data()
            content = json.dumps(user_data, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(content)
            return
        
        file_path = self.translate_path(self.path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            self.serve_static_file(file_path)
        else:
            self.send_error(404, "File Not Found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/user-data":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body.decode("utf-8"))
                save_user_data(data)
                res = json.dumps({"status": "ok"}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(res)
            except Exception as e:
                self.send_response(400)
                self.end_headers()
            return
        elif parsed.path == "/api/delete-song":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body.decode("utf-8"))
                song_id = data.get("id")
                if not song_id:
                    self.send_response(400)
                    self.end_headers()
                    return
                
                # Prevent directory traversal
                file_path = (DATA_DIR / song_id).resolve()
                if not str(file_path).startswith(str(DATA_DIR.resolve())):
                    self.send_response(403)
                    self.end_headers()
                    return
                
                if file_path.exists() and file_path.is_file():
                    os.remove(file_path)
                    
                    # Clean up deleted song from user_data.json
                    user_data = read_user_data()
                    modified = False
                    if "categories" in user_data and song_id in user_data["categories"]:
                        del user_data["categories"][song_id]
                        modified = True
                    if "recent" in user_data and song_id in user_data["recent"]:
                        user_data["recent"] = [r for r in user_data["recent"] if r != song_id]
                        modified = True
                    if modified:
                        save_user_data(user_data)

                    res = json.dumps({"status": "ok"}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(res)
                else:
                    self.send_response(404)
                    self.end_headers()
            except Exception as e:
                self.send_response(500)
                self.end_headers()
            return
            
        self.send_error(404, "Not Found")

def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
        
    os.chdir(BASE_DIR)
    songs_found = scan_songs()
    user_data = read_user_data()

    selected_port = PORT
    httpd = None

    for p in range(PORT, PORT + 10):
        try:
            socketserver.TCPServer.allow_reuse_address = True
            httpd = socketserver.TCPServer(("", p), MusicPlayerHandler)
            selected_port = p
            break
        except OSError:
            continue

    if httpd is None:
        print(f"Loi: Khong the mo cong tu {PORT} den {PORT+9}. Cong dang bi chiem dung.")
        sys.exit(1)

    print("==================================================")
    print("  [*] LOCAL MUSIC PLAYER IS RUNNING (LOCAL OFFLINE)")
    print("==================================================")
    print(f"  Tim thong tin {len(songs_found)} bai hat trong 'data/'.")
    print(f"  File du lieu nguoi dung: {USER_DATA_FILE.name} (Luu vinh vien tren o đia)")
    print(f"  Truy cap: http://localhost:{selected_port}")
    print("  RAM tieu thu: ~15MB | Support 206 Partial Content (Instant Seek)")
    print("==================================================")
    
    if "--no-browser" not in sys.argv:
        webbrowser.open(f"http://localhost:{selected_port}")
    
    with httpd:
        try:
            httpd.serve_forever()
        except (KeyboardInterrupt, SystemExit):
            print("\nDang dung server...")
            httpd.server_close()

if __name__ == "__main__":
    main()
