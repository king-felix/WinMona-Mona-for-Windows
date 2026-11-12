/* Records the exact argv it was started with, so the menu helper's quoting can
 * be verified without launching the real application. The test renames this
 * executable to Mona.exe, which is the name the helper launches.
 *
 * Output: MONA_ARGV_OUT receives the arguments as NUL-separated UTF-16LE with a
 * double-NUL terminator, which preserves every character exactly.
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#define UNICODE
#define _UNICODE

#include <windows.h>
#include <stdio.h>

int wmain(int argc, wchar_t **argv) {
    WCHAR output[MAX_PATH * 2];
    DWORD written = 0;
    FILE *file = NULL;
    int index = 0;

    if (!GetEnvironmentVariableW(L"MONA_ARGV_OUT", output, MAX_PATH * 2)) {
        return 3;
    }
    file = _wfopen(output, L"wb");
    if (!file) {
        return 4;
    }
    for (index = 0; index < argc; ++index) {
        written = (DWORD)wcslen(argv[index]) * sizeof(WCHAR);
        fwrite(argv[index], 1, written, file);
        fwrite(L"\0", sizeof(WCHAR), 1, file);
    }
    fwrite(L"\0", sizeof(WCHAR), 1, file);
    fclose(file);
    return 0;
}
