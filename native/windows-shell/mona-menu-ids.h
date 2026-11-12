/* Mona's modern Windows 11 context-menu helper.
 *
 * A single in-process COM server that answers IExplorerCommand. Explorer loads
 * it through the sparse package's surrogate server registration, so the helper
 * never registers shell keys of its own. Its whole job is: resolve the selected
 * folder, quote it correctly, and start Mona. It never touches the network,
 * never runs model work, and never builds a cmd/PowerShell string.
 */
#ifndef MONA_MENU_IDS_H
#define MONA_MENU_IDS_H

#include <guiddef.h>

/* The CLSID is written into the sparse package manifest verbatim. Changing it
 * means rebuilding and reinstalling the identity package. */
static const GUID CLSID_MonaMenu = {
    0x6d2f1c9a, 0x4b7e, 0x4e51, {0x9a, 0x3c, 0x1f, 0x8e, 0x5b, 0x0d, 0x7c, 0x42}};

/* GetCanonicalName must stay stable across versions so Explorer can remember
 * the command across upgrades. */
static const GUID GUID_MonaMenuCanonical = {
    0x6d2f1c9a, 0x4b7e, 0x4e51, {0x9a, 0x3c, 0x1f, 0x8e, 0x5b, 0x0d, 0x7c, 0x43}};

static const GUID IID_MonaExplorerCommand = {
    0xa08ce4d0, 0xfa25, 0x44ab, {0xb5, 0x7c, 0xc7, 0xb1, 0xc3, 0x23, 0xe0, 0xb9}};
static const GUID IID_MonaUnknown = {
    0x00000000, 0x0000, 0x0000, {0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
static const GUID IID_MonaClassFactory = {
    0x00000001, 0x0000, 0x0000, {0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};

/* Written by the per-user installer. The helper reads it so an upgrade moves
 * the menu target without re-registering the package. */
#define MONA_INSTALL_KEY L"Software\\Mona\\Install"
#define MONA_INSTALL_VALUE L"MonaExe"

#endif /* MONA_MENU_IDS_H */
