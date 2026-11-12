/* Real-process probe for MonaMenu.dll.
 *
 * Loads the helper the way a COM host does (LoadLibraryW + DllGetClassObject),
 * builds a genuine IShellItemArray from file-system paths, and exercises the
 * IExplorerCommand contract. It exists so the menu's behaviour can be verified
 * without a human right-click, and it prints JSON for the evidence log.
 *
 * Usage:
 *   MonaMenuProbe.exe --dll <path\MonaMenu.dll> --path <folder> [--invoke]
 *                     [--second <folder>] [--exe <installed Mona.exe>]
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <shobjidl.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mona-menu-ids.h"

typedef HRESULT(WINAPI *GetClassObjectFn)(REFCLSID, REFIID, void **);

static void print_json_string(const WCHAR *text) {
    const WCHAR *cursor = NULL;
    char buffer[4096];
    int written = 0;
    if (!text) {
        fputs("null", stdout);
        return;
    }
    fputc('"', stdout);
    for (cursor = text; *cursor; ++cursor) {
        WCHAR ch = *cursor;
        if (ch == L'"' || ch == L'\\') {
            fputc('\\', stdout);
            fputc((int)ch, stdout);
        } else if (ch < 0x20) {
            printf("\\u%04x", (unsigned)ch);
        } else {
            written = WideCharToMultiByte(CP_UTF8, 0, cursor, 1, buffer, sizeof(buffer), NULL, NULL);
            if (written > 0) {
                fwrite(buffer, 1, (size_t)written, stdout);
            }
        }
    }
    fputc('"', stdout);
}

static void print_guid(const GUID *value) {
    printf("\"{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}\"", (unsigned long)value->Data1,
           value->Data2, value->Data3, value->Data4[0], value->Data4[1], value->Data4[2],
           value->Data4[3], value->Data4[4], value->Data4[5], value->Data4[6], value->Data4[7]);
}

static IShellItem *shell_item(const WCHAR *path) {
    IShellItem *item = NULL;
    if (FAILED(SHCreateItemFromParsingName(path, NULL, &IID_IShellItem, (void **)&item))) {
        return NULL;
    }
    return item;
}

static IShellItemArray *single_item_array(const WCHAR *path) {
    IShellItem *item = shell_item(path);
    IShellItemArray *array = NULL;
    if (!item) {
        return NULL;
    }
    if (FAILED(SHCreateShellItemArrayFromShellItem(item, &IID_IShellItemArray, (void **)&array))) {
        array = NULL;
    }
    item->lpVtbl->Release(item);
    return array;
}

static IShellItemArray *two_item_array(const WCHAR *first, const WCHAR *second) {
    PIDLIST_ABSOLUTE ids[2] = {NULL, NULL};
    IShellItemArray *array = NULL;
    if (FAILED(SHParseDisplayName(first, NULL, &ids[0], 0, NULL))) {
        return NULL;
    }
    if (FAILED(SHParseDisplayName(second, NULL, &ids[1], 0, NULL))) {
        CoTaskMemFree(ids[0]);
        return NULL;
    }
    if (FAILED(SHCreateShellItemArrayFromIDLists(2, (PCIDLIST_ABSOLUTE_ARRAY)ids, &array))) {
        array = NULL;
    }
    CoTaskMemFree(ids[0]);
    CoTaskMemFree(ids[1]);
    return array;
}

static const char *state_name(EXPCMDSTATE state) {
    switch (state) {
        case ECS_ENABLED:
            return "enabled";
        case ECS_DISABLED:
            return "disabled";
        case ECS_HIDDEN:
            return "hidden";
        default:
            return "other";
    }
}

int wmain(int argc, wchar_t **argv) {
    const WCHAR *dll_path = NULL;
    const WCHAR *folder = NULL;
    const WCHAR *second = NULL;
    const WCHAR *installed_exe = NULL;
    int invoke = 0;
    int cocreate = 0;
    HMODULE library = NULL;
    GetClassObjectFn get_class_object = NULL;
    IClassFactory *factory = NULL;
    IExplorerCommand *command = NULL;
    IShellItemArray *selection = NULL;
    HRESULT status = S_OK;
    int index = 0;

    for (index = 1; index < argc; ++index) {
        if (wcscmp(argv[index], L"--dll") == 0 && index + 1 < argc) {
            dll_path = argv[++index];
        } else if (wcscmp(argv[index], L"--path") == 0 && index + 1 < argc) {
            folder = argv[++index];
        } else if (wcscmp(argv[index], L"--second") == 0 && index + 1 < argc) {
            second = argv[++index];
        } else if (wcscmp(argv[index], L"--exe") == 0 && index + 1 < argc) {
            installed_exe = argv[++index];
        } else if (wcscmp(argv[index], L"--invoke") == 0) {
            invoke = 1;
        } else if (wcscmp(argv[index], L"--cocreate") == 0) {
            cocreate = 1;
        } else {
            fwprintf(stderr, L"Unsupported argument: %s\n", argv[index]);
            return 2;
        }
    }
    if ((!cocreate && !dll_path) || !folder) {
        fwprintf(stderr, L"Usage: MonaMenuProbe --dll <MonaMenu.dll> --path <folder> [--invoke]\n");
        return 2;
    }

    /* The probe stands in for the installer when checking icon/launch targets. */
    if (installed_exe) {
        RegSetKeyValueW(HKEY_CURRENT_USER, MONA_INSTALL_KEY, MONA_INSTALL_VALUE, REG_SZ,
                        installed_exe, (DWORD)((wcslen(installed_exe) + 1) * sizeof(WCHAR)));
    }

    status = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(status)) {
        printf("{\"ok\":false,\"error\":\"CoInitializeEx failed\"}\n");
        return 1;
    }

    library = NULL;
    if (!cocreate) {
        library = LoadLibraryW(dll_path);
        if (!library) {
            printf("{\"ok\":false,\"error\":\"LoadLibrary failed\",\"win32\":%lu}\n",
                   (unsigned long)GetLastError());
            CoUninitialize();
            return 1;
        }
        get_class_object =
            (GetClassObjectFn)(void *)GetProcAddress(library, "DllGetClassObject");
        if (!get_class_object) {
            printf("{\"ok\":false,\"error\":\"DllGetClassObject is not exported\"}\n");
            FreeLibrary(library);
            CoUninitialize();
            return 1;
        }

        status = get_class_object(&CLSID_MonaMenu, &IID_MonaClassFactory, (void **)&factory);
        if (FAILED(status) || !factory) {
            printf("{\"ok\":false,\"error\":\"DllGetClassObject refused\",\"hr\":%ld}\n",
                   (long)status);
            FreeLibrary(library);
            CoUninitialize();
            return 1;
        }
        status = factory->lpVtbl->CreateInstance(factory, NULL, &IID_MonaExplorerCommand,
                                                (void **)&command);
        factory->lpVtbl->Release(factory);
    } else {
        /* The activation path Explorer uses once the package registers the COM
         * class: CoCreateInstance against the registered CLSID. */
        status = CoCreateInstance(&CLSID_MonaMenu, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_MonaExplorerCommand, (void **)&command);
    }
    if (FAILED(status) || !command) {
        printf("{\"ok\":false,\"error\":\"activation refused\",\"hr\":%ld}\n", (long)status);
        if (library) {
            FreeLibrary(library);
        }
        CoUninitialize();
        return 1;
    }

    selection = second ? two_item_array(folder, second) : single_item_array(folder);
    if (!selection) {
        printf("{\"ok\":false,\"error\":\"the selection could not be built\"}\n");
        command->lpVtbl->Release(command);
        if (library) {
            FreeLibrary(library);
        }
        CoUninitialize();
        return 1;
    }

    {
        LPWSTR title = NULL;
        LPWSTR icon = NULL;
        LPWSTR tooltip = NULL;
        GUID canonical = {0};
        EXPCMDSTATE state = ECS_HIDDEN;
        EXPCMDFLAGS flags = 0;
        IEnumExplorerCommand *subcommands = NULL;
        HRESULT invoke_status = S_FALSE;

        command->lpVtbl->GetTitle(command, selection, &title);
        command->lpVtbl->GetIcon(command, selection, &icon);
        command->lpVtbl->GetToolTip(command, selection, &tooltip);
        command->lpVtbl->GetCanonicalName(command, &canonical);
        command->lpVtbl->GetState(command, selection, TRUE, &state);
        command->lpVtbl->GetFlags(command, &flags);
        command->lpVtbl->EnumSubCommands(command, &subcommands);
        if (invoke) {
            invoke_status = command->lpVtbl->Invoke(command, selection, NULL);
        }

        printf("{\"ok\":true,\"title\":");
        print_json_string(title);
        printf(",\"icon\":");
        print_json_string(icon);
        printf(",\"tooltip\":");
        print_json_string(tooltip);
        printf(",\"canonical\":");
        print_guid(&canonical);
        printf(",\"state\":\"%s\",\"flags\":%lu", state_name(state), (unsigned long)flags);
        printf(",\"subcommands\":\"%s\"", subcommands ? "present" : "not-implemented");
        printf(",\"invoked\":%s", invoke ? "true" : "false");
        if (invoke) {
            printf(",\"invoke_hr\":%ld,\"invoke_ok\":%s", (long)invoke_status,
                   SUCCEEDED(invoke_status) ? "true" : "false");
        }
        printf("}\n");

        if (title) {
            CoTaskMemFree(title);
        }
        if (icon) {
            CoTaskMemFree(icon);
        }
        if (tooltip) {
            CoTaskMemFree(tooltip);
        }
        if (subcommands) {
            subcommands->lpVtbl->Release(subcommands);
        }
    }

    selection->lpVtbl->Release(selection);
    command->lpVtbl->Release(command);
    if (library) {
        FreeLibrary(library);
    }
    CoUninitialize();
    return 0;
}
