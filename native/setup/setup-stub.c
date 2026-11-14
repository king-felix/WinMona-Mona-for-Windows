/*
 * Mona setup bootstrapper.
 *
 * A recipient should double-click one file. This stub carries the whole staged
 * payload as an appended ZIP and installs it with the product's own installer —
 * no Node, no compiler, no source checkout. The payload is launched through
 * Mona.exe with ELECTRON_RUN_AS_NODE=1, which the shipped uninstaller already
 * relies on, so the installer script that runs here is the same one the
 * repository qualifies.
 *
 * Layout of the produced file:
 *
 *   [ stub PE image ][ payload bytes ][ trailer (32 bytes) ]
 *
 * The trailer is the magic below, then two little-endian 64-bit values: the
 * payload offset and its length. Appending the trailer last means a short or
 * corrupt download fails the size check instead of extracting garbage.
 *
 * It does no network work, changes no trust store, and prints a plain result.
 * Exit codes: 0 installed, 1 failed, 2 malformed package, 3 needs user action.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlwapi.h>
#include <strsafe.h>
#include <stdint.h>
#include <stdio.h>

#define TRAILER_SIZE 32
static const char TRAILER_MAGIC[16] = {'M', 'O', 'N', 'A', 'S', 'E', 'T', 'U',
                                       'P', '-', 'v', '1', '\0', '\0', '\0', '\0'};

typedef struct {
    uint64_t offset;
    uint64_t length;
} PayloadLocation;

static void say(const char *text) {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD written = 0;
    if (out == INVALID_HANDLE_VALUE || out == NULL) {
        return;
    }
    WriteFile(out, text, (DWORD)lstrlenA(text), &written, NULL);
}

/** Print a wide string as UTF-8 so Unicode paths stay readable. */
static void say_w(const WCHAR *text) {
    int needed = WideCharToMultiByte(CP_UTF8, 0, text, -1, NULL, 0, NULL, NULL);
    if (needed <= 1) {
        return;
    }
    char *buffer = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)needed);
    if (!buffer) {
        return;
    }
    if (WideCharToMultiByte(CP_UTF8, 0, text, -1, buffer, needed, NULL, NULL) > 0) {
        say(buffer);
    }
    HeapFree(GetProcessHeap(), 0, buffer);
}

/** Read the appended trailer and validate it against the real file size. */
static int locate_payload(const WCHAR *self, PayloadLocation *out, HANDLE *handle) {
    HANDLE file = INVALID_HANDLE_VALUE;
    LARGE_INTEGER size;
    unsigned char trailer[TRAILER_SIZE];
    DWORD read = 0;
    uint64_t offset = 0;
    uint64_t length = 0;
    int index = 0;

    file = CreateFileW(self, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        say("Mona setup: this file could not be opened for reading.\n");
        return 1;
    }
    if (!GetFileSizeEx(file, &size) || size.QuadPart < (LONGLONG)(TRAILER_SIZE + 1024)) {
        say("Mona setup: this file is too small to be a complete setup package.\n");
        CloseHandle(file);
        return 2;
    }
    if (SetFilePointerEx(file, (LARGE_INTEGER){.QuadPart = size.QuadPart - TRAILER_SIZE}, NULL, FILE_BEGIN) == 0) {
        CloseHandle(file);
        return 2;
    }
    if (!ReadFile(file, trailer, TRAILER_SIZE, &read, NULL) || read != TRAILER_SIZE) {
        say("Mona setup: the package trailer could not be read.\n");
        CloseHandle(file);
        return 2;
    }
    if (memcmp(trailer, TRAILER_MAGIC, sizeof(TRAILER_MAGIC)) != 0) {
        say("Mona setup: this is not a Mona setup package (bad trailer).\n");
        CloseHandle(file);
        return 2;
    }
    memcpy(&offset, trailer + 16, sizeof(uint64_t));
    memcpy(&length, trailer + 24, sizeof(uint64_t));
    if (length == 0 || offset + length + TRAILER_SIZE != (uint64_t)size.QuadPart) {
        say("Mona setup: the package is truncated or corrupt. Download it again.\n");
        CloseHandle(file);
        return 2;
    }
    for (index = 0; index < 4; ++index) {
        /* ZIP local file header: PK\x03\x04 */
        static const unsigned char zip_magic[4] = {0x50, 0x4b, 0x03, 0x04};
        unsigned char probe[4];
        if (SetFilePointerEx(file, (LARGE_INTEGER){.QuadPart = (LONGLONG)(offset + (uint64_t)index)}, NULL, FILE_BEGIN) == 0) {
            break;
        }
        if (!ReadFile(file, probe, 4, &read, NULL) || read != 4) {
            break;
        }
        if (memcmp(probe, zip_magic, 4) == 0) {
            break;
        }
    }
    *out = (PayloadLocation){.offset = offset, .length = length};
    *handle = file;
    return 0;
}

/** Copy the payload out of this executable into a ZIP file. */
static int write_payload(HANDLE self, const PayloadLocation *payload, const WCHAR *target) {
    HANDLE out = INVALID_HANDLE_VALUE;
    LARGE_INTEGER position;
    unsigned char buffer[1 << 16];
    uint64_t remaining = payload->length;

    out = CreateFileW(target, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (out == INVALID_HANDLE_VALUE) {
        say("Mona setup: the payload could not be written to the temporary folder.\n");
        return 1;
    }
    position.QuadPart = (LONGLONG)payload->offset;
    if (SetFilePointerEx(self, position, NULL, FILE_BEGIN) == 0) {
        CloseHandle(out);
        return 1;
    }
    while (remaining > 0) {
        DWORD want = (DWORD)(remaining > sizeof(buffer) ? sizeof(buffer) : remaining);
        DWORD got = 0;
        DWORD wrote = 0;
        if (!ReadFile(self, buffer, want, &got, NULL) || got == 0) {
            CloseHandle(out);
            say("Mona setup: the payload ended early; the file is truncated.\n");
            return 2;
        }
        if (!WriteFile(out, buffer, got, &wrote, NULL) || wrote != got) {
            CloseHandle(out);
            say("Mona setup: the payload could not be written (disk full or read-only).\n");
            return 1;
        }
        remaining -= got;
    }
    CloseHandle(out);
    return 0;
}

/** Run a program and wait for it, returning its exit code. */
static int run_and_wait(const WCHAR *application, WCHAR *commandLine, int quiet) {
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    DWORD code = 1;

    ZeroMemory(&startup, sizeof(startup));
    startup.cb = sizeof(startup);
    ZeroMemory(&process, sizeof(process));
    if (!CreateProcessW(application, commandLine, NULL, NULL, FALSE, CREATE_UNICODE_ENVIRONMENT, NULL, NULL,
                        &startup, &process)) {
        say("Mona setup: could not start ");
        say_w(application);
        say(".\n");
        return 1;
    }
    if (!quiet) {
        say("  running the installer...\n");
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return (int)code;
}

/** Echo a text file to the console, bounded, so a failure explains itself. */
static void echo_file(const WCHAR *file) {
    HANDLE handle = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    char buffer[4096];
    DWORD got = 0;
    if (handle == INVALID_HANDLE_VALUE) {
        return;
    }
    while (ReadFile(handle, buffer, sizeof(buffer) - 1, &got, NULL) && got > 0) {
        buffer[got] = '\0';
        say(buffer);
    }
    CloseHandle(handle);
}

/**
 * Put the process into Electron's Node mode.
 *
 * The stub sets the variable in its own environment and lets the child inherit
 * it. Hand-building an environment block was the first attempt and silently lost
 * the variable, which made Electron start as a GUI app and fail to find an app
 * path; inheriting from this process is both simpler and what the shipped
 * uninstall.cmd relies on.
 */
static void enter_node_mode(void) {
    SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1");
}

static int run_installer(const WCHAR *payloadDir, int quiet, const WCHAR *jsonPath) {
    WCHAR exe[32768];
    WCHAR command[32768];
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    DWORD code = 1;
    WCHAR logPath[MAX_PATH + 96];
    HANDLE logFile = INVALID_HANDLE_VALUE;
    SECURITY_ATTRIBUTES inheritable;

    if (FAILED(StringCchPrintfW(exe, ARRAYSIZE(exe), L"%s\\Mona.exe", payloadDir))) {
        return 1;
    }
    if (GetFileAttributesW(exe) == INVALID_FILE_ATTRIBUTES) {
        /* The stage keeps Mona.exe at its root; the identity folder holds only
           the package manifest and assets. */
        say("Mona setup: the payload does not contain Mona.exe.\n");
        return 2;
    }
    if (FAILED(StringCchPrintfW(command, ARRAYSIZE(command),
                                L"\"%s\" \"%s\\installer\\cli.mjs\" install --stage \"%s\" --force%s%s%s", exe,
                                payloadDir, payloadDir, jsonPath ? L" --json \"" : L"",
                                jsonPath ? jsonPath : L"", jsonPath ? L"\"" : L""))) {
        return 1;
    }
    if (FAILED(StringCchPrintfW(logPath, ARRAYSIZE(logPath), L"%s\\installer-output.log", payloadDir))) {
        return 1;
    }
    /* The installer's own report is the only useful explanation of a failure, so
       it is captured rather than left in a console nobody can see. */
    inheritable.nLength = sizeof(inheritable);
    inheritable.lpSecurityDescriptor = NULL;
    inheritable.bInheritHandle = TRUE;
    logFile = CreateFileW(logPath, GENERIC_WRITE, FILE_SHARE_READ, &inheritable, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                          NULL);
    enter_node_mode();
    ZeroMemory(&startup, sizeof(startup));
    startup.cb = sizeof(startup);
    if (logFile != INVALID_HANDLE_VALUE) {
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdOutput = logFile;
        startup.hStdError = logFile;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    }
    ZeroMemory(&process, sizeof(process));
    if (!quiet) {
        say("  installing Mona for this user...\n");
    }
    if (!CreateProcessW(exe, command, NULL, NULL, logFile != INVALID_HANDLE_VALUE, CREATE_UNICODE_ENVIRONMENT, NULL, payloadDir, &startup, &process)) {
        say("Mona setup: the installer could not be started (the payload may be blocked by policy).\n");
        if (logFile != INVALID_HANDLE_VALUE) CloseHandle(logFile);
        return 1;
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    if (logFile != INVALID_HANDLE_VALUE) CloseHandle(logFile);
    if (code != 0) {
        say("\n--- installer output ---\n");
        echo_file(logPath);
        say("\n--- end of installer output ---\n");
    }
    return (int)code;
}

int wmain(int argc, WCHAR **argv) {
    WCHAR self[32768];
    WCHAR tempRoot[MAX_PATH];
    WCHAR workDir[MAX_PATH + 64];
    WCHAR zipPath[MAX_PATH + 96];
    WCHAR payloadDir[MAX_PATH + 96];
    PayloadLocation payload = {0, 0};
    HANDLE selfHandle = INVALID_HANDLE_VALUE;
    int quiet = 0;
    int index = 0;
    const WCHAR *jsonPath = NULL;
    int result = 0;
    DWORD written = 0;

    for (index = 1; index < argc; ++index) {
        if (lstrcmpiW(argv[index], L"--quiet") == 0 || lstrcmpiW(argv[index], L"/quiet") == 0) {
            quiet = 1;
        } else if ((lstrcmpiW(argv[index], L"--json") == 0) && index + 1 < argc) {
            jsonPath = argv[++index];
        } else if (lstrcmpiW(argv[index], L"--help") == 0 || lstrcmpiW(argv[index], L"/?") == 0) {
            say("Mona setup: installs Mona for the current user.\n");
            say("  --quiet          do not pause before exiting\n");
            say("  --json <path>    write the installer result to <path>\n");
            return 0;
        }
    }

    if (GetModuleFileNameW(NULL, self, ARRAYSIZE(self)) == 0) {
        return 1;
    }
    if (!quiet) {
        say("Mona 0.1.0 setup\n");
        say("  installs for the current user; no administrator rights are used\n");
    }
    result = locate_payload(self, &payload, &selfHandle);
    if (result != 0) {
        goto done;
    }
    if (GetTempPathW(MAX_PATH, tempRoot) == 0) {
        result = 1;
        goto done;
    }
    if (FAILED(StringCchPrintfW(workDir, ARRAYSIZE(workDir), L"%smona-setup-%lu", GetTempPathW(MAX_PATH, tempRoot) ? tempRoot : L"",
                                GetCurrentProcessId()))) {
        result = 1;
        goto done;
    }
    if (!CreateDirectoryW(workDir, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) {
        result = 1;
        goto done;
    }
    if (FAILED(StringCchPrintfW(zipPath, ARRAYSIZE(zipPath), L"%s\\payload.zip", workDir)) ||
        FAILED(StringCchPrintfW(payloadDir, ARRAYSIZE(payloadDir), L"%s\\payload", workDir))) {
        result = 1;
        goto done;
    }
    if (!CreateDirectoryW(payloadDir, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) {
        result = 1;
        goto done;
    }
    if (!quiet) {
        say("  unpacking the application...\n");
    }
    result = write_payload(selfHandle, &payload, zipPath);
    if (result != 0) {
        goto done;
    }
    /* bsdtar ships with Windows 10/11 and reads ZIP through libarchive. It keeps
       the archive's own paths, so nothing is composed into a command line. */
    {
        WCHAR tarExe[MAX_PATH];
        WCHAR tarCommand[MAX_PATH * 3];
        if (FAILED(StringCchPrintfW(tarExe, ARRAYSIZE(tarExe), L"%s\\System32\\tar.exe",
                                    _wgetenv(L"SystemRoot") ? _wgetenv(L"SystemRoot") : L"C:\\Windows")) ||
            FAILED(StringCchPrintfW(tarCommand, ARRAYSIZE(tarCommand), L"tar.exe -xf \"%s\" -C \"%s\"", zipPath,
                                    payloadDir))) {
            result = 1;
            goto done;
        }
        result = run_and_wait(tarExe, tarCommand, quiet);
        if (result != 0) {
            say("Mona setup: the application could not be unpacked (tar.exe failed).\n");
            goto done;
        }
    }
    result = run_installer(payloadDir, quiet, jsonPath);
done:
    if (selfHandle != INVALID_HANDLE_VALUE) {
        CloseHandle(selfHandle);
    }
    if (result == 0) {
        say("Mona is installed. Open it from the Start menu.\n");
    } else if (result == 3) {
        say("Mona could not finish installing because it is running. Quit Mona and run this file again.\n");
    } else if (result != 2) {
        say("Mona was not installed. The installer's report above explains why.\n");
    }
    /* Best effort: the payload is large and leaving it would waste the disk. */
    {
        WCHAR cleanup[MAX_PATH * 3];
        if (SUCCEEDED(StringCchPrintfW(cleanup, ARRAYSIZE(cleanup), L"cmd.exe /c rmdir /s /q \"%s\"", workDir))) {
            STARTUPINFOW startup;
            PROCESS_INFORMATION process;
            ZeroMemory(&startup, sizeof(startup));
            startup.cb = sizeof(startup);
            startup.dwFlags = STARTF_USESHOWWINDOW;
            startup.wShowWindow = SW_HIDE;
            ZeroMemory(&process, sizeof(process));
            if (CreateProcessW(NULL, cleanup, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &startup, &process)) {
                WaitForSingleObject(process.hProcess, 60000);
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
        }
    }
    if (!quiet) {
        say("\nPress Enter to close this window.\n");
        {
            char line[8];
            DWORD read = 0;
            ReadFile(GetStdHandle(STD_INPUT_HANDLE), line, sizeof(line) - 1, &read, NULL);
        }
    }
    (void)written;
    return result;
}
