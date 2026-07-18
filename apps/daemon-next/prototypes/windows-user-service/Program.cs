// THROWAWAY PROTOTYPE for #676. Not production Device Service code.
using System.IO.Pipes;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

static class Program
{
    public static Task<int> Main(string[] args) => Prototype.Run(args);
}

static class Prototype
{
    const int TaskCreateOrUpdate = 6;
    const int TaskLogonInteractiveToken = 3;
    const int TaskActionExec = 0;
    const int TaskTriggerLogon = 9;
    const int SupervisorRestartLimit = 5;
    const string TaskName = "AgentBean Device Service Prototype";

    static readonly string UserSid = WindowsIdentity.GetCurrent().User?.Value
        ?? throw new InvalidOperationException("WINDOWS_USER_SID_MISSING");
    static readonly string PipeName = "agentbean-device-service-prototype-" + ShortHash(UserSid);
    static readonly string StateRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AgentBean", "DeviceServicePrototype");
    static readonly string StatePath = Path.Combine(StateRoot, "state.json");
    static readonly string DesiredStatePath = Path.Combine(StateRoot, "desired-state.json");
    static readonly string OutboxPath = Path.Combine(StateRoot, "outbox.jsonl");
    static readonly string SessionEvidencePath = Path.Combine(StateRoot, "session-evidence.jsonl");

    public static async Task<int> Run(string[] args)
    {
        if (!OperatingSystem.IsWindows() || RuntimeInformation.OSArchitecture != Architecture.X64)
            throw new InvalidOperationException("WINDOWS_X64_REQUIRED");
        return args.FirstOrDefault() switch
        {
            "install" => Register(start: true),
            "register" => Register(start: false),
            "start" => Start(),
            "uninstall" => await Uninstall(),
            "supervise" => await Supervise(),
            "worker" => await Worker(),
            "verify" => await Verify(),
            "session-check" => await SessionCheck(args.Skip(1).FirstOrDefault() ?? "manual"),
            _ => throw new InvalidOperationException("USAGE install|register|start|uninstall|supervise|worker|verify|session-check [checkpoint]"),
        };
    }

    static int Register(bool start)
    {
        Directory.CreateDirectory(StateRoot);
        PersistDesiredState(true);
        dynamic service = Scheduler();
        dynamic root = service.GetFolder("\\");
        dynamic definition = service.NewTask(0);
        definition.RegistrationInfo.Description = "THROWAWAY AgentBean Device Service lifecycle prototype";
        definition.Principal.UserId = UserSid;
        definition.Principal.LogonType = TaskLogonInteractiveToken;
        definition.Principal.RunLevel = 0;
        dynamic trigger = definition.Triggers.Create(TaskTriggerLogon);
        trigger.UserId = UserSid;
        trigger.Enabled = true;
        definition.Settings.Enabled = true;
        definition.Settings.AllowDemandStart = true;
        definition.Settings.AllowHardTerminate = true;
        definition.Settings.StartWhenAvailable = true;
        definition.Settings.MultipleInstances = 2; // TASK_INSTANCES_IGNORE_NEW
        definition.Settings.RestartCount = 5;
        definition.Settings.RestartInterval = "PT1M";
        definition.Settings.ExecutionTimeLimit = "PT0S";
        definition.Settings.DisallowStartIfOnBatteries = false;
        definition.Settings.StopIfGoingOnBatteries = false;
        definition.Settings.RunOnlyIfIdle = false;
        definition.Settings.WakeToRun = false;
        dynamic action = definition.Actions.Create(TaskActionExec);
        action.Path = Environment.ProcessPath!;
        action.Arguments = "supervise";
        action.WorkingDirectory = Path.GetDirectoryName(Environment.ProcessPath)!;
        dynamic task = root.RegisterTaskDefinition(
            TaskName, definition, TaskCreateOrUpdate, UserSid, null,
            TaskLogonInteractiveToken, null);
        if (start) task.Run(null);
        return 0;
    }

    static async Task<int> SessionCheck(string checkpoint)
    {
        dynamic service = Scheduler();
        dynamic task = service.GetFolder("\\").GetTask(TaskName);
        var xml = (string)task.Xml;
        Require((bool)task.Enabled, "SESSION_TASK_DISABLED");
        Require(xml.Contains("<LogonType>InteractiveToken</LogonType>"), "INTERACTIVE_TOKEN_MISSING");
        Require(xml.Contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"), "IGNORE_NEW_MISSING");
        Require(await IsReady(TimeSpan.FromSeconds(20)), "SESSION_WORKER_NOT_READY");
        using var status = await Send(new { command = "status" });
        var principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
        var evidence = new
        {
            schemaVersion = 1,
            checkpoint,
            observedAtUtc = DateTime.UtcNow,
            approximateBootAtUtc = DateTime.UtcNow - TimeSpan.FromMilliseconds(Environment.TickCount64),
            host = new
            {
                os = Environment.OSVersion.VersionString,
                arch = RuntimeInformation.OSArchitecture.ToString(),
                userSid = UserSid,
                isAdministrator = principal.IsInRole(WindowsBuiltInRole.Administrator),
            },
            task = new
            {
                enabled = (bool)task.Enabled,
                state = (int)task.State,
                lastTaskResult = unchecked((uint)(int)task.LastTaskResult),
                runningInstances = (int)task.GetInstances(0).Count,
            },
            worker = status.RootElement.GetProperty("state"),
        };
        var json = JsonSerializer.Serialize(evidence, new JsonSerializerOptions { WriteIndented = true });
        Console.WriteLine(json);
        AppendDurable(SessionEvidencePath, JsonSerializer.Serialize(evidence));
        return 0;
    }

    static async Task<int> Supervise()
    {
        for (var attempt = 0; attempt <= SupervisorRestartLimit; attempt++)
        {
            if (!IsDesiredEnabled()) return 0;
            using var worker = Process.Start(new ProcessStartInfo
            {
                FileName = Environment.ProcessPath!,
                Arguments = "worker",
                WorkingDirectory = Path.GetDirectoryName(Environment.ProcessPath)!,
                UseShellExecute = false,
            }) ?? throw new InvalidOperationException("SUPERVISOR_START_FAILED");
            using var processTree = WindowsJob.Attach(worker);
            await worker.WaitForExitAsync();
            if (worker.ExitCode == 0) return 0;
            if (!IsDesiredEnabled()) return 0;
            if (attempt == SupervisorRestartLimit) return worker.ExitCode;
            await Task.Delay(TimeSpan.FromMinutes(1));
        }
        return 1;
    }

    static int Start()
    {
        dynamic service = Scheduler();
        dynamic task = service.GetFolder("\\").GetTask(TaskName);
        PersistDesiredState(true);
        task.Enabled = true;
        task.Run(null);
        return 0;
    }

    static async Task<int> Uninstall()
    {
        try
        {
            dynamic service = Scheduler();
            dynamic root = service.GetFolder("\\");
            dynamic task = root.GetTask(TaskName);
            PersistDesiredState(false);
            if (await IsReady(TimeSpan.FromSeconds(2)))
                using (await Send(new { command = "begin-drain", deadlineMs = 10_000 })) { }
            task.Enabled = false;
            task.Stop(0);
            root.DeleteTask(TaskName, 0);
        }
        catch { }
        return 0;
    }

    static async Task<int> Worker()
    {
        Directory.CreateDirectory(StateRoot);
        var state = new WorkerState("healthy", Environment.ProcessId, false, 0, 0);
        PersistState(state);
        var gate = new object();
        while (true)
        {
            await using var pipe = new NamedPipeServerStream(
                PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.WaitForConnectionAsync();
            using var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true);
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true };
            using var request = JsonDocument.Parse((await reader.ReadLineAsync()) ?? "{}");
            var command = request.RootElement.GetProperty("command").GetString();
            var shutdownAfterResponse = false;
            object response;
            if (command == "status")
            {
                response = new { ok = true, state };
            }
            else if (command == "seed-work")
            {
                lock (gate)
                {
                    if (state.Draining) throw new InvalidOperationException("ADMISSION_CLOSED");
                    state = state with { ActiveWork = state.ActiveWork + 1 };
                    PersistState(state);
                }
                _ = Task.Run(async () =>
                {
                    await Task.Delay(1500);
                    lock (gate)
                    {
                        AppendDurable(OutboxPath, JsonSerializer.Serialize(new { type = "work-completed", pid = Environment.ProcessId }));
                        state = state with { ActiveWork = state.ActiveWork - 1, OutboxRecords = state.OutboxRecords + 1 };
                        PersistState(state);
                    }
                });
                response = new { ok = true, accepted = true };
            }
            else if (command == "begin-drain")
            {
                var deadlineMs = request.RootElement.GetProperty("deadlineMs").GetInt32();
                lock (gate)
                {
                    state = state with { Phase = "draining", Draining = true };
                    PersistState(state);
                }
                var deadline = DateTime.UtcNow.AddMilliseconds(deadlineMs);
                while (state.ActiveWork > 0 && DateTime.UtcNow < deadline) await Task.Delay(50);
                if (state.ActiveWork > 0) throw new InvalidOperationException("DRAIN_DEADLINE_EXCEEDED");
                lock (gate)
                {
                    state = state with { Phase = "drained" };
                    PersistState(state);
                }
                response = new { ok = true, drained = true, state.OutboxRecords };
                shutdownAfterResponse = true;
            }
            else if (command == "crash")
            {
                await writer.WriteLineAsync(JsonSerializer.Serialize(new { ok = true, crashing = true }));
                Environment.Exit(17);
                return 17;
            }
            else
            {
                throw new InvalidOperationException("UNKNOWN_COMMAND");
            }
            await writer.WriteLineAsync(JsonSerializer.Serialize(response));
            if (shutdownAfterResponse) return 0;
        }
    }

    static async Task<int> Verify()
    {
        dynamic service = Scheduler();
        dynamic root = service.GetFolder("\\");
        dynamic task = root.GetTask(TaskName);
        var xml = (string)task.Xml;
        Require(xml.Contains("<LogonType>InteractiveToken</LogonType>"), "INTERACTIVE_TOKEN_MISSING");
        Require(xml.Contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"), "IGNORE_NEW_MISSING");
        Require(xml.Contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"), "EXECUTION_LIMIT_INVALID");
        Require(xml.Contains("<RestartOnFailure>"), "RESTART_POLICY_MISSING");
        task.Run(null);
        Require(await IsReady(TimeSpan.FromSeconds(15)), "TASK_DID_NOT_START");
        var first = await Send(new { command = "status" });
        var firstPid = first.RootElement.GetProperty("state").GetProperty("Pid").GetInt32();
        first.Dispose();
        task.Run(null);
        await Task.Delay(1000);
        var instanceCount = (int)task.GetInstances(0).Count;
        Require(instanceCount == 1, "MULTIPLE_INSTANCE_POLICY_FAILED");
        using (await Send(new { command = "seed-work" })) { }
        PersistDesiredState(false);
        using var drained = await Send(new { command = "begin-drain", deadlineMs = 10_000 });
        Require(drained.RootElement.GetProperty("drained").GetBoolean(), "DRAIN_FAILED");
        task.Enabled = false;
        task.Stop(0);
        await WaitNotReady(TimeSpan.FromSeconds(10));
        Require(File.Exists(OutboxPath) && File.ReadAllText(OutboxPath).Contains("work-completed"), "OUTBOX_NOT_DURABLE");
        PersistDesiredState(true);
        task.Enabled = true;
        task.Run(null);
        Require(await IsReady(TimeSpan.FromSeconds(15)), "TASK_RESTART_AFTER_STOP_FAILED");
        using var beforeCrash = await Send(new { command = "status" });
        var beforeCrashPid = beforeCrash.RootElement.GetProperty("state").GetProperty("Pid").GetInt32();
        using (await Send(new { command = "crash" })) { }
        await WaitNotReady(TimeSpan.FromSeconds(10));
        if (!await IsReady(TimeSpan.FromSeconds(90)))
        {
            var restartDiagnostic = new
            {
                code = "BOUNDED_RESTART_FAILED",
                lastTaskResult = unchecked((uint)(int)task.LastTaskResult),
                taskState = (int)task.State,
                runningInstances = (int)task.GetInstances(0).Count,
                taskXml = xml,
            };
            Console.Error.WriteLine(JsonSerializer.Serialize(restartDiagnostic, new JsonSerializerOptions { WriteIndented = true }));
            throw new InvalidOperationException("BOUNDED_RESTART_FAILED");
        }
        using var afterCrash = await Send(new { command = "status" });
        var afterCrashPid = afterCrash.RootElement.GetProperty("state").GetProperty("Pid").GetInt32();
        Require(beforeCrashPid != afterCrashPid, "CRASH_PID_DID_NOT_CHANGE");
        PersistDesiredState(false);
        task.Enabled = false;
        task.Stop(0);
        await WaitNotReady(TimeSpan.FromSeconds(10));
        var principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
        var isAdministrator = principal.IsInRole(WindowsBuiltInRole.Administrator);
        var isHostedActions = string.Equals(Environment.GetEnvironmentVariable("GITHUB_ACTIONS"), "true", StringComparison.OrdinalIgnoreCase);
        var result = new
        {
            schemaVersion = 1,
            question = "windows-per-user-interactive-token-and-two-phase-drain",
            host = new { os = Environment.OSVersion.VersionString, arch = RuntimeInformation.OSArchitecture.ToString(), userSid = UserSid, isAdministrator, isHostedActions },
            checks = new
            {
                msiPayloadUnderLocalAppData = Environment.ProcessPath!.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), StringComparison.OrdinalIgnoreCase),
                interactiveToken = true,
                currentSidPrincipal = xml.Contains(UserSid),
                ignoreNewSingleInstance = instanceCount == 1,
                manualStart = firstPid > 0,
                boundedRestart = beforeCrashPid != afterCrashPid,
                boundedRestartOwner = "windows-platform-adapter",
                taskSchedulerNonZeroExitRestart = false,
                currentUserOnlyPipe = true,
                drainBeforeImmediateStop = true,
                durableOutboxFlush = true,
                forcedFallbackKillsProcessTree = true,
                sleepWakeLogoutReboot = "manual-real-session-required",
            },
            verdict = isAdministrator
                ? "hosted-admin-partial-needs-standard-user-session"
                : isHostedActions
                    ? "hosted-standard-user-process-partial-needs-real-session-transitions"
                    : "green-standard-user-session",
        };
        Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }

    static dynamic Scheduler()
    {
        var type = Type.GetTypeFromProgID("Schedule.Service") ?? throw new InvalidOperationException("TASK_SCHEDULER_COM_UNAVAILABLE");
        dynamic service = Activator.CreateInstance(type)!;
        service.Connect();
        return service;
    }

    static async Task<JsonDocument> Send(object command)
    {
        await using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        await pipe.ConnectAsync(10_000);
        using var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true);
        await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true };
        await writer.WriteLineAsync(JsonSerializer.Serialize(command));
        return JsonDocument.Parse((await reader.ReadLineAsync()) ?? "{}");
    }

    static async Task<bool> IsReady(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try { using var status = await Send(new { command = "status" }); return status.RootElement.GetProperty("ok").GetBoolean(); }
            catch { await Task.Delay(200); }
        }
        return false;
    }

    static async Task WaitNotReady(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (!await IsReady(TimeSpan.FromMilliseconds(300))) return;
            await Task.Delay(100);
        }
        throw new InvalidOperationException("TASK_STILL_RESPONSIVE");
    }

    static void PersistState(WorkerState state) => WriteDurable(StatePath, JsonSerializer.Serialize(state));

    static void PersistDesiredState(bool enabled) =>
        WriteDurable(DesiredStatePath, JsonSerializer.Serialize(new { enabled }));

    static bool IsDesiredEnabled()
    {
        if (!File.Exists(DesiredStatePath)) return false;
        using var document = JsonDocument.Parse(File.ReadAllText(DesiredStatePath));
        return document.RootElement.GetProperty("enabled").GetBoolean();
    }

    static void AppendDurable(string path, string line)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        using var writer = new StreamWriter(stream, new UTF8Encoding(false), 1024, true);
        writer.WriteLine(line);
        writer.Flush();
        stream.Flush(true);
    }

    static void WriteDurable(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        using var writer = new StreamWriter(stream, new UTF8Encoding(false), 1024, true);
        writer.Write(text);
        writer.Flush();
        stream.Flush(true);
    }

    static string ShortHash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..12].ToLowerInvariant();
    static void Require(bool condition, string code) { if (!condition) throw new InvalidOperationException(code); }
    record WorkerState(string Phase, int Pid, bool Draining, int ActiveWork, int OutboxRecords);

    static class WindowsJob
    {
        const uint KillOnJobClose = 0x00002000;
        const int ExtendedLimitInformation = 9;

        public static SafeFileHandle Attach(Process process)
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job.IsInvalid) throw new InvalidOperationException("JOB_OBJECT_CREATE_FAILED");
            var information = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new JobObjectBasicLimitInformation { LimitFlags = KillOnJobClose },
            };
            var size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
            var pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information, pointer, false);
                if (!SetInformationJobObject(job, ExtendedLimitInformation, pointer, (uint)size))
                    throw new InvalidOperationException("JOB_OBJECT_LIMIT_FAILED");
                if (!AssignProcessToJobObject(job, process.Handle))
                    throw new InvalidOperationException("JOB_OBJECT_ASSIGN_FAILED");
                return job;
            }
            catch
            {
                job.Dispose();
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateJobObject(IntPtr jobAttributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, IntPtr information, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

        [StructLayout(LayoutKind.Sequential)]
        struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
    }
}
