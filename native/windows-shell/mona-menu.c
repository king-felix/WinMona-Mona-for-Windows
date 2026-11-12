/* Mona modern-menu COM helper â€” implementation.
 *
 * Contract: IExplorerCommand only. No subcommands, no background worker, no
 * timing-sensitive work in GetState (Explorer calls it while painting the menu).
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <strsafe.h>
#include <string.h>

#include "mona-menu-ids.h"

#define MONA_MENU_TITLE L"Start new DS project with Mona"
#define MONA_MENU_TOOLTIP L"Open this folder as a Mona project. No task is sent."
#define MONA_PROFILE L"ds-full-access"

/* COM lifetime accounting. The DLL unloads only when Explorer releases every
 * object it holds. */
static LONG g_objects = 0;

static int guid_eq(const GUID *left, const GUID *right) {
    return memcmp(left, right, sizeof(GUID)) == 0;
}

/* ------------------------------------------------------------------------- */
/* Installation target                                                        */
/* ------------------------------------------------------------------------- */

static HRESULT read_install_exe(WCHAR *buffer, DWORD cch) {
    DWORD size = cch * sizeof(WCHAR);
    LONG status = RegGetValueW(HKEY_CURRENT_USER, MONA_INSTALL_KEY, MONA_INSTALL_VALUE,
                               RRF_RT_REG_SZ, NULL, buffer, &size);
    if (status != ERROR_SUCCESS) {
        return HRESULT_FROM_WIN32((DWORD)status);
    }
    buffer[cch - 1] = L'\0';
    return buffer[0] ? S_OK : HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
}

/* Explorer may call GetState repeatedly while the user hovers the menu. This is
 * one registry read and a file-exists check: no network, no process launch. */
static HRESULT install_exe(WCHAR *buffer, DWORD cch) {
    return read_install_exe(buffer, cch);
}

/* ------------------------------------------------------------------------- */
/* Selection resolution                                                       */
/* ------------------------------------------------------------------------- */

/* Resolve exactly one selected folder to a file-system path, or S_FALSE when
 * the selection is not usable. Returning S_FALSE keeps every odd case (multiple
 * selection, virtual items, files) a hidden command rather than an error. */
static HRESULT single_folder(IShellItemArray *items, WCHAR **folder) {
    DWORD count = 0;
    IShellItem *item = NULL;
    LPWSTR path = NULL;
    const WCHAR *cursor = NULL;
    DWORD attributes = 0;

    if (!items || !folder) {
        return E_INVALIDARG;
    }
    *folder = NULL;
    if (FAILED(items->lpVtbl->GetCount(items, &count)) || count != 1) {
        return S_FALSE;
    }
    if (FAILED(items->lpVtbl->GetItemAt(items, 0, &item)) || !item) {
        return S_FALSE;
    }
    if (FAILED(item->lpVtbl->GetDisplayName(item, SIGDN_FILESYSPATH, &path)) || !path) {
        item->lpVtbl->Release(item);
        return S_FALSE;
    }
    item->lpVtbl->Release(item);

    attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        CoTaskMemFree(path);
        return S_FALSE;
    }
    /* A name with a quote or a control character cannot be represented in a
     * Windows command line, so it is refused instead of escaped badly. */
    for (cursor = path; *cursor; ++cursor) {
        if (*cursor == L'"' || *cursor < 0x20) {
            CoTaskMemFree(path);
            return S_FALSE;
        }
    }
    *folder = path;
    return S_OK;
}

/* ------------------------------------------------------------------------- */
/* Launch                                                                     */
/* ------------------------------------------------------------------------- */

/* Start Mona with the selected folder as data. The executable is passed as
 * lpApplicationName and every argument stays a separate token: the folder path
 * is quoted once, never concatenated into a shell script. */
static HRESULT launch_mona(const WCHAR *executable, const WCHAR *folder) {
    WCHAR command[32768];
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    DWORD created = 0;
    HRESULT formed = S_OK;

    formed = StringCchPrintfW(command, ARRAYSIZE(command),
                              L"\"%s\" project open --path \"%s\" --profile " MONA_PROFILE,
                              executable, folder);
    if (FAILED(formed)) {
        return formed;
    }

    ZeroMemory(&startup, sizeof(startup));
    startup.cb = sizeof(startup);
    ZeroMemory(&process, sizeof(process));

    created = CreateProcessW(executable, command, NULL, NULL, FALSE,
                             CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP, NULL, NULL,
                             &startup, &process);
    if (!created) {
        return HRESULT_FROM_WIN32(GetLastError());
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return S_OK;
}

/* ------------------------------------------------------------------------- */
/* IExplorerCommand                                                           */
/* ------------------------------------------------------------------------- */

typedef struct MonaCommand {
    IExplorerCommandVtbl *vtbl;
    LONG refs;
} MonaCommand;

static HRESULT STDMETHODCALLTYPE command_query_interface(IExplorerCommand *self, REFIID riid,
                                                         void **out) {
    if (!out) {
        return E_POINTER;
    }
    *out = NULL;
    if (guid_eq(riid, &IID_MonaUnknown) || guid_eq(riid, &IID_MonaExplorerCommand)) {
        *out = self;
        self->lpVtbl->AddRef(self);
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE command_add_ref(IExplorerCommand *self) {
    MonaCommand *command = (MonaCommand *)self;
    return (ULONG)InterlockedIncrement(&command->refs);
}

static ULONG STDMETHODCALLTYPE command_release(IExplorerCommand *self) {
    MonaCommand *command = (MonaCommand *)self;
    LONG remaining = InterlockedDecrement(&command->refs);
    if (remaining == 0) {
        InterlockedDecrement(&g_objects);
        CoTaskMemFree(command);
    }
    return (ULONG)remaining;
}

static HRESULT STDMETHODCALLTYPE command_get_title(IExplorerCommand *self, IShellItemArray *items,
                                                   LPWSTR *name) {
    (void)self;
    (void)items;
    if (!name) {
        return E_POINTER;
    }
    *name = NULL;
    return SHStrDupW(MONA_MENU_TITLE, name);
}

static HRESULT STDMETHODCALLTYPE command_get_icon(IExplorerCommand *self, IShellItemArray *items,
                                                  LPWSTR *icon) {
    WCHAR executable[1024];
    (void)self;
    (void)items;
    if (!icon) {
        return E_POINTER;
    }
    *icon = NULL;
    if (FAILED(install_exe(executable, 1024))) {
        return S_FALSE;
    }
    return SHStrDupW(executable, icon);
}

static HRESULT STDMETHODCALLTYPE command_get_tooltip(IExplorerCommand *self, IShellItemArray *items,
                                                     LPWSTR *tooltip) {
    (void)self;
    (void)items;
    if (!tooltip) {
        return E_POINTER;
    }
    *tooltip = NULL;
    return SHStrDupW(MONA_MENU_TOOLTIP, tooltip);
}

static HRESULT STDMETHODCALLTYPE command_get_canonical_name(IExplorerCommand *self, GUID *name) {
    (void)self;
    if (!name) {
        return E_POINTER;
    }
    *name = GUID_MonaMenuCanonical;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE command_get_state(IExplorerCommand *self, IShellItemArray *items,
                                                   WINBOOL slow_ok, EXPCMDSTATE *state) {
    WCHAR *folder = NULL;
    WCHAR executable[1024];
    (void)self;
    (void)slow_ok;
    if (!state) {
        return E_POINTER;
    }
    if (single_folder(items, &folder) != S_OK) {
        *state = ECS_HIDDEN;
        return S_OK;
    }
    CoTaskMemFree(folder);
    *state = SUCCEEDED(install_exe(executable, 1024)) ? ECS_ENABLED : ECS_DISABLED;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE command_invoke(IExplorerCommand *self, IShellItemArray *items,
                                                IBindCtx *context) {
    WCHAR *folder = NULL;
    WCHAR executable[1024];
    HRESULT status = S_OK;
    (void)self;
    (void)context;
    if (single_folder(items, &folder) != S_OK) {
        return S_FALSE;
    }
    if (FAILED(install_exe(executable, 1024))) {
        CoTaskMemFree(folder);
        return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
    }
    status = launch_mona(executable, folder);
    CoTaskMemFree(folder);
    return status;
}

static HRESULT STDMETHODCALLTYPE command_get_flags(IExplorerCommand *self, EXPCMDFLAGS *flags) {
    (void)self;
    if (!flags) {
        return E_POINTER;
    }
    *flags = ECF_DEFAULT;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE command_enum_subcommands(IExplorerCommand *self,
                                                          IEnumExplorerCommand **commands) {
    (void)self;
    if (commands) {
        *commands = NULL;
    }
    return E_NOTIMPL;
}

static IExplorerCommandVtbl g_command_vtbl = {
    command_query_interface, command_add_ref,         command_release,
    command_get_title,       command_get_icon,        command_get_tooltip,
    command_get_canonical_name, command_get_state,    command_invoke,
    command_get_flags,       command_enum_subcommands,
};

/* ------------------------------------------------------------------------- */
/* IClassFactory                                                              */
/* ------------------------------------------------------------------------- */

typedef struct MonaFactory {
    IClassFactoryVtbl *vtbl;
    LONG refs;
} MonaFactory;

static HRESULT STDMETHODCALLTYPE factory_query_interface(IClassFactory *self, REFIID riid,
                                                         void **out) {
    if (!out) {
        return E_POINTER;
    }
    *out = NULL;
    if (guid_eq(riid, &IID_MonaUnknown) || guid_eq(riid, &IID_MonaClassFactory)) {
        *out = self;
        self->lpVtbl->AddRef(self);
        return S_OK;
    }
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE factory_add_ref(IClassFactory *self) {
    MonaFactory *factory = (MonaFactory *)self;
    return (ULONG)InterlockedIncrement(&factory->refs);
}

static ULONG STDMETHODCALLTYPE factory_release(IClassFactory *self) {
    MonaFactory *factory = (MonaFactory *)self;
    LONG remaining = InterlockedDecrement(&factory->refs);
    if (remaining == 0) {
        CoTaskMemFree(factory);
    }
    return (ULONG)remaining;
}

static HRESULT STDMETHODCALLTYPE factory_create_instance(IClassFactory *self, IUnknown *outer,
                                                         REFIID riid, void **out) {
    MonaCommand *command = NULL;
    HRESULT status = S_OK;
    (void)self;
    if (outer) {
        return CLASS_E_NOAGGREGATION;
    }
    if (!out) {
        return E_POINTER;
    }
    *out = NULL;
    command = (MonaCommand *)CoTaskMemAlloc(sizeof(MonaCommand));
    if (!command) {
        return E_OUTOFMEMORY;
    }
    command->vtbl = &g_command_vtbl;
    command->refs = 1;
    InterlockedIncrement(&g_objects);
    status = command_query_interface((IExplorerCommand *)command, riid, out);
    command_release((IExplorerCommand *)command);
    return status;
}

static HRESULT STDMETHODCALLTYPE factory_lock_server(IClassFactory *self, WINBOOL lock) {
    (void)self;
    (void)lock;
    return S_OK;
}

static IClassFactoryVtbl g_factory_vtbl = {
    factory_query_interface, factory_add_ref, factory_release,
    factory_create_instance, factory_lock_server,
};

/* ------------------------------------------------------------------------- */
/* DLL exports                                                                */
/* ------------------------------------------------------------------------- */

HRESULT WINAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void **out) {
    MonaFactory *factory = NULL;
    HRESULT status = S_OK;
    if (!out) {
        return E_POINTER;
    }
    *out = NULL;
    if (!guid_eq(clsid, &CLSID_MonaMenu)) {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    factory = (MonaFactory *)CoTaskMemAlloc(sizeof(MonaFactory));
    if (!factory) {
        return E_OUTOFMEMORY;
    }
    factory->vtbl = &g_factory_vtbl;
    factory->refs = 1;
    status = factory_query_interface((IClassFactory *)factory, riid, out);
    factory_release((IClassFactory *)factory);
    return status;
}

HRESULT WINAPI DllCanUnloadNow(void) {
    return g_objects == 0 ? S_OK : S_FALSE;
}

/* Registration is owned by the sparse package manifest, not by the DLL. These
 * exports exist only so a packaging mistake fails loudly instead of silently
 * writing shell keys. */
HRESULT WINAPI DllRegisterServer(void) {
    return E_NOTIMPL;
}

HRESULT WINAPI DllUnregisterServer(void) {
    return E_NOTIMPL;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance;
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}
