// Release builds must not open a console window; debug builds keep it so
// stdout/stderr stay visible while developing the shell.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow};

/// The Pi Web server, kept so the whole tree can be killed when the app exits.
struct ServerProcess(Mutex<Option<Child>>);

fn main() {
    // Thousands of launches must not grow the trace forever.
    trim_log();
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            thread::spawn(move || boot(&handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pi Web desktop")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                log("exit event received");
                if let Some(state) = app_handle.try_state::<ServerProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        log(&format!("killing pid = {}", child.id()));
                        kill_tree(&mut child);
                    } else {
                        log("no server process to kill");
                    }
                }
            }
        });
}

/// How long the sidecar gets to answer before the window shows a failure.
/// Its first request waits for the pi SDK import instrumentation started, which
/// takes seconds on Windows (#964); the budget also covers a cold machine.
const START_TIMEOUT: Duration = Duration::from_secs(150);

/// Start the server, wait for it to answer, then send the window to it.
fn boot(handle: &AppHandle) {
    match handle.path().resource_dir() {
        Ok(dir) => log(&format!("resource_dir = {}", dir.display())),
        Err(error) => log(&format!("resource_dir error: {error}")),
    }

    let Some(window) = handle.get_webview_window("main") else {
        log("no main window");
        return;
    };

    let (node, package) = match resolve_runtime(handle) {
        Ok(found) => found,
        Err(error) => {
            log(&format!("resolve failed: {error}"));
            fail(&window, "Pi Web could not be started.", &error);
            return;
        }
    };
    log(&format!("resolved node = {}", node.display()));
    log(&format!("resolved package = {}", package.display()));

    let port = match free_port() {
        Ok(port) => port,
        Err(error) => {
            fail(&window, "Pi Web could not be started.", &format!("No free local port: {error}"));
            return;
        }
    };

    log(&format!("free port = {port}"));

    let (mut child, ready) = match spawn_server(&node, &package, port) {
        Ok(spawned) => spawned,
        Err(error) => {
            log(&format!("spawn failed: {error}"));
            fail(&window, "Pi Web could not be started.", &error);
            return;
        }
    };
    log(&format!("spawned pid = {}", child.id()));

    match wait_for_server(&mut child, port, &ready) {
        ServerStart::Ready => {}
        ServerStart::Exited(status) => {
            log(&format!("server exited before it answered ({status})"));
            let what = match status.code() {
                Some(code) => format!("exited with code {code}"),
                None => "was terminated".to_string(),
            };
            fail(
                &window,
                "Pi Web could not be started.",
                &format!(
                    "The local server {what} before it answered on 127.0.0.1:{port}.\n\
                     Its output is in %TEMP%\\pi-web-desktop.log."
                ),
            );
            return;
        }
        ServerStart::TimedOut => {
            log("timed out waiting for the server");
            kill_tree(&mut child);
            fail(
                &window,
                "Pi Web did not become ready in time.",
                &format!(
                    "Nothing answered on 127.0.0.1:{port} within {} seconds.",
                    START_TIMEOUT.as_secs()
                ),
            );
            return;
        }
    }

    // The child only reaches the exit handler once it has answered, so a failed
    // start leaves no server running behind the error page.
    if let Some(state) = handle.try_state::<ServerProcess>() {
        *state.0.lock().unwrap() = Some(child);
    }

    if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}")) {
        log(&format!("navigating to {url}"));
        let _ = window.navigate(url);
    } else {
        log("failed to build the url");
    }
}

/// `node <package>/start.js` with PORT and HOSTNAME in the environment: the
/// packaged tree starts Next's standalone server itself, not the pi-web CLI.
fn spawn_server(node: &Path, package: &Path, port: u16) -> Result<(Child, Arc<AtomicBool>), String> {
    let mut child = quiet_command(node)
        .arg(package.join("start.js"))
        .current_dir(package)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to run {}: {error}", node.display()))?;

    let ready = Arc::new(AtomicBool::new(false));

    if let Some(stream) = child.stdout.take() {
        let ready = Arc::clone(&ready);
        thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                match line {
                    Ok(text) => {
                        // Next logs this once it accepts requests. Waiting for
                        // the line beats probing the port: a connection can be
                        // accepted long before the server answers on it, which
                        // left every probe waiting out its read timeout.
                        if text.contains("Ready in") || text.contains("Local:") {
                            ready.store(true, Ordering::SeqCst);
                        }
                        log(&format!("[out] {text}"));
                    }
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(stream) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                match line {
                    Ok(text) => log(&format!("[err] {text}")),
                    Err(_) => break,
                }
            }
        });
    }

    #[cfg(windows)]
    match job::KillOnCloseJob::create() {
        Some(job) => {
            if job.assign(&child) {
                let _ = SERVER_JOB.set(job);
            } else {
                log("could not put the sidecar into a job object");
            }
        }
        None => log("could not create a job object"),
    }

    Ok((child, ready))
}

/// Let the OS pick a free port, then hand it to the server. Reading the port
/// back from the server's output would need `--port 0`, whose real port the
/// parent never learns.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// How the wait for the sidecar ended.
enum ServerStart {
    /// It printed its ready line, or answered the probe.
    Ready,
    /// It died: a bad Node version, a missing module, a port it could not take.
    Exited(ExitStatus),
    /// Still running, never answered, budget spent.
    TimedOut,
}

/// Waits for the sidecar to answer, or for it to die first.
fn wait_for_server(child: &mut Child, port: u16, ready: &AtomicBool) -> ServerStart {
    let deadline = Instant::now() + START_TIMEOUT;
    let mut next_status_at = Instant::now();
    let mut last_probe = String::from("none");
    let request = format!("GET /api/home HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");

    while Instant::now() < deadline {
        // A sidecar that died never prints "Ready", so without this check the
        // window reports a timeout for what is actually a crash.
        if let Ok(Some(status)) = child.try_wait() {
            return ServerStart::Exited(status);
        }

        if ready.load(Ordering::SeqCst) {
            log("server reported ready");
            return ServerStart::Ready;
        }

        if Instant::now() >= next_status_at {
            log(&format!("waiting on port {port} - last probe: {last_probe}"));
            next_status_at = Instant::now() + Duration::from_secs(5);
        }
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(mut stream) => {
                // Fallback path only: a port that accepts a connection may
                // still be initialising, and a long timeout here would eat the
                // whole budget, so keep it short and retry.
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                if stream.write_all(request.as_bytes()).is_err() {
                    last_probe = "write failed".to_string();
                } else {
                    let mut buffer = [0u8; 512];
                    match stream.read(&mut buffer) {
                        Ok(0) => last_probe = "read 0 bytes".to_string(),
                        Ok(read) => {
                            let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                            let preview: String = head.chars().take(48).collect();
                            last_probe = format!("read {read} bytes: {preview:?}");
                            if head.contains("200 OK") {
                                return ServerStart::Ready;
                            }
                        }
                        Err(error) => last_probe = format!("read error: {error}"),
                    }
                }
            }
            Err(error) => last_probe = format!("connect error: {error}"),
        }

        thread::sleep(Duration::from_millis(250));
    }
    log(&format!("gave up on port {port} - last probe: {last_probe}"));
    ServerStart::TimedOut
}

/// Where the bundled Node and the Pi Web package live.
fn resolve_runtime(handle: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let mut bases: Vec<PathBuf> = Vec::new();

    if let Ok(home) = std::env::var("PI_WEB_HOME") {
        bases.push(PathBuf::from(home));
    }
    if let Ok(resources) = handle.path().resource_dir() {
        bases.push(resources.join("resources"));
    }
    #[cfg(windows)]
    if let Ok(appdata) = std::env::var("APPDATA") {
        bases.push(PathBuf::from(appdata).join("npm").join("node_modules").join("@agegr").join("pi-web"));
    }

    for base in bases {
        log(&format!("candidate base = {}", base.display()));
        // Either the package itself, or a resources dir holding `pi-web/`.
        let package = if base.join("bin").join("pi-web.js").exists() {
            base.clone()
        } else {
            base.join("pi-web")
        };
        if !package.join("bin").join("pi-web.js").exists() {
            continue;
        }
        if let Some(node) = find_node(&base) {
            return Ok((normalize(node), normalize(package)));
        }
    }

    Err("No Pi Web package with a usable Node runtime was found.".to_string())
}

/// Tauri hands out verbatim paths (`\\?\F:\...`). Node 24 resolves such a
/// path to the bare drive letter and dies with
/// `EISDIR: illegal operation on a directory, lstat 'F:'`, so hand it the
/// plain form instead.
fn normalize(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn find_node(base: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = base.join("node").join(name);
    if bundled.exists() {
        return Some(bundled);
    }
    which_node().ok()
}

/// Development convenience: fall back to a Node on PATH.
fn which_node() -> Result<PathBuf, ()> {
    #[cfg(windows)]
    {
        let output = quiet_command("cmd").args(["/C", "where node"]).output().map_err(|_| ())?;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let line = line.trim();
            if line.to_ascii_lowercase().ends_with("node.exe") {
                return Ok(PathBuf::from(line));
            }
        }
        Err(())
    }
    #[cfg(not(windows))]
    {
        let output = Command::new("sh").args(["-c", "command -v node"]).output().map_err(|_| ())?;
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Err(())
        } else {
            Ok(PathBuf::from(path))
        }
    }
}

#[cfg(windows)]
fn kill_tree(child: &mut Child) {
    // pi-web.js spawns a `next` child of its own; killing only the parent
    // would leave that one holding the port.
    let _ = quiet_command("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The kernel reaps the sidecar through this job: when the last handle to the
/// job closes — including an abrupt kill, where no Rust code runs — every
/// process inside it is terminated. `taskkill /T` in kill_tree only covers the
/// graceful path.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct KillOnCloseJob(HANDLE);

    // The handle belongs to this job alone and is closed only in Drop.
    unsafe impl Send for KillOnCloseJob {}
    unsafe impl Sync for KillOnCloseJob {}

    impl KillOnCloseJob {
        pub fn create() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }

                Some(Self(handle))
            }
        }

        pub fn assign(&self, child: &Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0 }
        }
    }

    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Held for the whole process lifetime; the OS closes the handle on exit.
#[cfg(windows)]
static SERVER_JOB: std::sync::OnceLock<job::KillOnCloseJob> = std::sync::OnceLock::new();

/// Windows gives every console-subsystem child of a GUI app its own console
/// window. CREATE_NO_WINDOW keeps the Node sidecar, taskkill and the `where`
/// probe silent. std adds CREATE_UNICODE_ENVIRONMENT on its own.
fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

/// A GUI app has no console, so startup traces go to a log file under %TEMP%.
/// It is capped at the start of a run, which keeps the current run complete.
const LOG_MAX_BYTES: u64 = 1024 * 1024;

fn log_file_path() -> PathBuf {
    std::env::temp_dir().join("pi-web-desktop.log")
}

fn trim_log() {
    let path = log_file_path();
    if let Ok(metadata) = std::fs::metadata(&path) {
        if metadata.len() > LOG_MAX_BYTES {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn log(line: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path())
    {
        let _ = writeln!(file, "{line}");
    }
}

fn fail(window: &WebviewWindow, message: &str, detail: &str) {
    let script = format!(
        "document.getElementById('box').classList.add('failed');\
         document.getElementById('message').textContent={};\
         document.getElementById('detail').textContent={};",
        serde_json::to_string(message).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(detail).unwrap_or_else(|_| "\"\"".to_string()),
    );
    let _ = window.eval(script);
}
