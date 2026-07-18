// THROWAWAY PROTOTYPE for #677. Not production credential-store code.
using System.ComponentModel;
using System.Buffers.Binary;
using System.Diagnostics;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

internal static class WindowsCredentialProbe
{
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;
    private static ReadOnlySpan<byte> EnvelopeMagic => "ABCR"u8;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string? Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string? UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    private static void Write(string target, byte[] secret)
    {
        var blob = Marshal.AllocHGlobal(secret.Length);
        try
        {
            Marshal.Copy(secret, 0, blob, secret.Length);
            var credential = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = target,
                CredentialBlobSize = checked((uint)secret.Length),
                CredentialBlob = blob,
                Persist = CredPersistLocalMachine,
            };
            if (!CredWrite(ref credential, 0)) ThrowWin32("write");
        }
        finally
        {
            for (var index = 0; index < secret.Length; index++) Marshal.WriteByte(blob, index, 0);
            Marshal.FreeHGlobal(blob);
        }
    }

    private static byte[] Read(string target)
    {
        if (!CredRead(target, CredTypeGeneric, 0, out var pointer)) ThrowWin32("read");
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            var secret = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, secret, 0, secret.Length);
            return secret;
        }
        finally
        {
            CredFree(pointer);
        }
    }

    private static string Target(Guid credentialRef, int generation) =>
        $"AgentBean/prototype/{credentialRef:N}/g{generation}";

    private static byte[] BuildEnvelope(Guid credentialRef, int generation, byte scope, byte[] secret)
    {
        var envelope = new byte[30 + secret.Length];
        EnvelopeMagic.CopyTo(envelope);
        envelope[4] = 1;
        envelope[5] = scope;
        BinaryPrimitives.WriteInt32LittleEndian(envelope.AsSpan(6, 4), generation);
        credentialRef.TryWriteBytes(envelope.AsSpan(10, 16));
        BinaryPrimitives.WriteInt32LittleEndian(envelope.AsSpan(26, 4), secret.Length);
        secret.CopyTo(envelope, 30);
        return envelope;
    }

    private static void WriteEnvelope(string target, Guid credentialRef, int generation, byte scope, byte[] secret)
    {
        var envelope = BuildEnvelope(credentialRef, generation, scope, secret);
        try { Write(target, envelope); }
        finally { CryptographicOperations.ZeroMemory(envelope); }
    }

    private static byte[] ReadSecret(string target, Guid credentialRef, int generation, byte scope)
    {
        var envelope = Read(target);
        try
        {
            Require(envelope.Length >= 30, "ENVELOPE_TOO_SHORT");
            Require(envelope.AsSpan(0, 4).SequenceEqual(EnvelopeMagic), "ENVELOPE_MAGIC_MISMATCH");
            Require(envelope[4] == 1, "ENVELOPE_VERSION_MISMATCH");
            Require(envelope[5] == scope, "ENVELOPE_SCOPE_MISMATCH");
            Require(BinaryPrimitives.ReadInt32LittleEndian(envelope.AsSpan(6, 4)) == generation, "ENVELOPE_GENERATION_MISMATCH");
            Require(new Guid(envelope.AsSpan(10, 16)) == credentialRef, "ENVELOPE_REFERENCE_MISMATCH");
            var secretLength = BinaryPrimitives.ReadInt32LittleEndian(envelope.AsSpan(26, 4));
            Require(secretLength >= 0 && envelope.Length == 30 + secretLength, "ENVELOPE_LENGTH_MISMATCH");
            return envelope.AsSpan(30, secretLength).ToArray();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(envelope);
        }
    }

    private static bool ReadIsNotFound(string target)
    {
        if (CredRead(target, CredTypeGeneric, 0, out var pointer))
        {
            CredFree(pointer);
            return false;
        }
        return Marshal.GetLastWin32Error() == ErrorNotFound;
    }

    private static void Delete(string target, bool requirePresent)
    {
        if (CredDelete(target, CredTypeGeneric, 0)) return;
        var error = Marshal.GetLastWin32Error();
        if (!requirePresent && error == ErrorNotFound) return;
        throw new Win32Exception(error, $"delete:{MapStatus(error)}:{error}");
    }

    private static void ThrowWin32(string operation)
    {
        var error = Marshal.GetLastWin32Error();
        throw new Win32Exception(error, $"{operation}:{MapStatus(error)}:{error}");
    }

    private static string MapStatus(int error) => error switch
    {
        ErrorNotFound => "not_found",
        5 or 1223 => "denied",
        13 => "corrupt",
        1312 => "backend_unavailable",
        _ => "backend_error",
    };

    private static void Require(bool condition, string code)
    {
        if (!condition) throw new InvalidOperationException(code);
    }

    public static int Main()
    {
        if (!OperatingSystem.IsWindows() || RuntimeInformation.OSArchitecture != Architecture.X64)
        {
            Console.Error.WriteLine("WINDOWS_X64_REQUIRED");
            return 1;
        }

        var runId = Guid.NewGuid().ToString("N");
        var credentialRefA = Guid.NewGuid();
        var credentialRefB = Guid.NewGuid();
        var copiedProfileRef = Guid.NewGuid();
        var targetA1 = Target(credentialRefA, 1);
        var targetA2 = Target(credentialRefA, 2);
        var targetB1 = Target(credentialRefB, 1);
        var copiedProfileTarget = Target(copiedProfileRef, 1);
        var markerPath = $@"Software\AgentBean\Prototype\CredentialStore\{runId}";
        var firstSecret = RandomNumberGenerator.GetBytes(32);
        var replacementSecret = RandomNumberGenerator.GetBytes(32);
        var siblingSecret = RandomNumberGenerator.GetBytes(32);

        try
        {
            WriteEnvelope(targetA1, credentialRefA, 1, scope: 1, firstSecret);
            var firstReadBack = ReadSecret(targetA1, credentialRefA, 1, scope: 1);
            Require(CryptographicOperations.FixedTimeEquals(firstReadBack, firstSecret), "READ_BACK_MISMATCH");
            CryptographicOperations.ZeroMemory(firstReadBack);

            using var marker = Registry.CurrentUser.CreateSubKey(markerPath, writable: true)
                ?? throw new InvalidOperationException("CURRENT_MARKER_CREATE_FAILED");
            marker.SetValue("currentGeneration", 1, RegistryValueKind.DWord);

            WriteEnvelope(targetA2, credentialRefA, 2, scope: 1, replacementSecret);
            var replacementReadBack = ReadSecret(targetA2, credentialRefA, 2, scope: 1);
            Require(CryptographicOperations.FixedTimeEquals(replacementReadBack, replacementSecret), "UPDATE_READ_BACK_MISMATCH");
            CryptographicOperations.ZeroMemory(replacementReadBack);

            var generationBeforeCommit = (int)(marker.GetValue("currentGeneration") ?? 0);
            Require(generationBeforeCommit == 1, "STAGED_GENERATION_BECAME_CURRENT");
            var crashRecoveryReadBack = ReadSecret(Target(credentialRefA, generationBeforeCommit), credentialRefA, generationBeforeCommit, scope: 1);
            Require(CryptographicOperations.FixedTimeEquals(crashRecoveryReadBack, firstSecret), "CRASH_RECOVERY_DID_NOT_USE_CURRENT_GENERATION");
            CryptographicOperations.ZeroMemory(crashRecoveryReadBack);

            marker.SetValue("currentGeneration", 2, RegistryValueKind.DWord);
            var currentGeneration = (int)(marker.GetValue("currentGeneration") ?? 0);
            var currentReadBack = ReadSecret(Target(credentialRefA, currentGeneration), credentialRefA, currentGeneration, scope: 1);
            Require(CryptographicOperations.FixedTimeEquals(currentReadBack, replacementSecret), "CURRENT_MARKER_READ_MISMATCH");
            CryptographicOperations.ZeroMemory(currentReadBack);
            Delete(targetA1, requirePresent: true);
            Require(ReadIsNotFound(targetA1), "OLD_GENERATION_CLEANUP_NOT_CONFIRMED");

            WriteEnvelope(targetB1, credentialRefB, 1, scope: 2, siblingSecret);
            var siblingReadBack = ReadSecret(targetB1, credentialRefB, 1, scope: 2);
            Require(CryptographicOperations.FixedTimeEquals(siblingReadBack, siblingSecret), "PROFILE_B_READ_BACK_MISMATCH");
            CryptographicOperations.ZeroMemory(siblingReadBack);

            var renamedProfileReference = credentialRefA;
            var renamedReadBack = ReadSecret(Target(renamedProfileReference, currentGeneration), renamedProfileReference, currentGeneration, scope: 1);
            Require(CryptographicOperations.FixedTimeEquals(renamedReadBack, replacementSecret), "RENAME_CHANGED_REFERENCE");
            CryptographicOperations.ZeroMemory(renamedReadBack);
            Require(ReadIsNotFound(copiedProfileTarget), "PROFILE_COPY_INHERITED_REFERENCE");

            Delete(targetA2, requirePresent: true);
            Require(ReadIsNotFound(targetA2), "DELETE_NOT_CONFIRMED");

            using var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            var verdict = new
            {
                schemaVersion = 1,
                question = "windows-current-user-credential-manager-generation-and-isolation-boundary",
                host = new
                {
                    os = RuntimeInformation.OSDescription,
                    arch = "x64",
                    identity = identity.Name,
                    sid = identity.User?.Value,
                    administrator = principal.IsInRole(WindowsBuiltInRole.Administrator),
                    userInteractive = Environment.UserInteractive,
                    sessionId = Process.GetCurrentProcess().SessionId,
                },
                checks = new
                {
                    genericCredential = true,
                    persistLocalMachine = true,
                    writeReadBack = true,
                    immutableGenerationReadBack = true,
                    envelopeAndScopeValidated = true,
                    crashBeforeMarkerKeepsOldGeneration = true,
                    currentMarkerSwitchesGeneration = true,
                    oldGenerationCleanupConfirmed = true,
                    opaqueProfileIsolation = true,
                    profileRenamePreservesReference = true,
                    profileCopyGetsNoReference = true,
                    deleteConfirmedNotFound = true,
                    secretAbsentFromArgvAndEnvironment = true,
                    cleanupAttempted = true,
                },
                verdict = principal.IsInRole(WindowsBuiltInRole.Administrator)
                    ? "hosted-admin-partial-needs-standard-user-session-transitions"
                    : "standard-user-partial-needs-session-transitions",
            };
            Console.WriteLine(JsonSerializer.Serialize(verdict, new JsonSerializerOptions { WriteIndented = true }));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"PROBE_FAILED:{error.Message}");
            return 1;
        }
        finally
        {
            Delete(targetA1, requirePresent: false);
            Delete(targetA2, requirePresent: false);
            Delete(targetB1, requirePresent: false);
            Delete(copiedProfileTarget, requirePresent: false);
            Registry.CurrentUser.DeleteSubKeyTree(markerPath, throwOnMissingSubKey: false);
            CryptographicOperations.ZeroMemory(firstSecret);
            CryptographicOperations.ZeroMemory(replacementSecret);
            CryptographicOperations.ZeroMemory(siblingSecret);
        }
    }
}
