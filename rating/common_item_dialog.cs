// Windows Common Item Dialog keeps file and folder selection in the same
// Explorer UI. PowerShell loads this source in memory; no package is installed.
using System;
using System.IO;
using System.Runtime.InteropServices;

namespace ModelRating
{
    public static class CommonItemDialog
    {
        private const uint PickFolders = 0x20;
        private const uint ForceFileSystem = 0x40;
        private const uint AllowMultiSelect = 0x200;
        private const uint PathMustExist = 0x800;
        private const uint FileMustExist = 0x1000;
        private const uint DontAddToRecent = 0x02000000;
        private const uint FileSystemPath = 0x80058000;
        private const int Cancelled = unchecked((int)0x800704C7);

        public static string Choose(string kind, string initialPath, IntPtr owner)
        {
            bool folder = kind == "directory";
            if (!folder && kind != "file")
                throw new ArgumentException("Expected directory or file", "kind");

            IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialog();
            IShellItem initialFolder = null;
            IShellItem result = null;
            try
            {
                uint options;
                dialog.GetOptions(out options);
                options |= ForceFileSystem | PathMustExist | DontAddToRecent;
                options &= ~AllowMultiSelect;
                options |= folder ? PickFolders : FileMustExist;
                dialog.SetOptions(options);
                dialog.SetTitle(folder ? "选择模型文件夹" : "选择 DB 模型文件");
                dialog.SetOkButtonLabel(folder ? "选择文件夹" : "选择 DB 文件");
                dialog.SetFileNameLabel(folder ? "文件夹" : "DB 文件");

                if (!folder)
                {
                    FilterSpec[] filters = { new FilterSpec("SQLite 模型文件 (*.db)", "*.db") };
                    dialog.SetFileTypes((uint)filters.Length, filters);
                    dialog.SetFileTypeIndex(1);
                }

                string directory = null;
                if (!String.IsNullOrWhiteSpace(initialPath))
                {
                    if (Directory.Exists(initialPath))
                        directory = Path.GetFullPath(initialPath);
                    else if (File.Exists(initialPath))
                    {
                        directory = Path.GetDirectoryName(Path.GetFullPath(initialPath));
                        if (!folder && String.Equals(Path.GetExtension(initialPath), ".db", StringComparison.OrdinalIgnoreCase))
                            dialog.SetFileName(Path.GetFileName(initialPath));
                    }
                }
                if (!String.IsNullOrEmpty(directory))
                {
                    Guid shellItemId = typeof(IShellItem).GUID;
                    int status = SHCreateItemFromParsingName(directory, IntPtr.Zero, ref shellItemId, out initialFolder);
                    if (status >= 0)
                    {
                        dialog.SetFolder(initialFolder);
                        Marshal.FinalReleaseComObject(initialFolder);
                        initialFolder = null;
                    }
                }

                int shown = dialog.Show(owner);
                if (shown == Cancelled) return null;
                Marshal.ThrowExceptionForHR(shown);
                dialog.GetResult(out result);
                IntPtr path = IntPtr.Zero;
                try
                {
                    result.GetDisplayName(FileSystemPath, out path);
                    return Marshal.PtrToStringUni(path);
                }
                finally
                {
                    if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path);
                }
            }
            finally
            {
                if (result != null) Marshal.FinalReleaseComObject(result);
                if (initialFolder != null) Marshal.FinalReleaseComObject(initialFolder);
                Marshal.FinalReleaseComObject(dialog);
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct FilterSpec
        {
            [MarshalAs(UnmanagedType.LPWStr)] public string Name;
            [MarshalAs(UnmanagedType.LPWStr)] public string Pattern;
            public FilterSpec(string name, string pattern) { Name = name; Pattern = pattern; }
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        private static extern int SHCreateItemFromParsingName(
            string path, IntPtr bindContext, ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

        [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
        private class FileOpenDialog { }

        // Keep the native method order through GetResult, including unused slots.
        [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr owner);
            void SetFileTypes(uint count, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] FilterSpec[] filters);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem folder);
            void SetFolder(IShellItem folder);
            void GetFolder(out IShellItem folder);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void GetResult(out IShellItem item);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid interfaceId, out IntPtr result);
            void GetParent(out IShellItem parent);
            void GetDisplayName(uint nameType, out IntPtr name);
            void GetAttributes(uint mask, out uint attributes);
            void Compare(IShellItem other, uint hint, out int order);
        }
    }
}
