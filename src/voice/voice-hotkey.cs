using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;

// Windows default input device. Single 20s buffer; reset returns partial audio
// on key-up. No hooks, injected keys, disk audio, or Minecraft modifications.
public static class GamePtt {
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [StructLayout(LayoutKind.Sequential,Pack=2)] struct Format {
        public ushort tag,channels;public uint rate,bytes;public ushort align,bits,extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct Header {
        public IntPtr data;public uint length,recorded;public UIntPtr user;
        public uint flags,loops;public IntPtr next;public UIntPtr reserved;
    }
    [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr h,uint device,ref Format f,IntPtr callback,IntPtr instance,uint flags);
    [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr h,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr h,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr h);
    [DllImport("winmm.dll")] static extern uint waveInReset(IntPtr h);
    [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr h,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr h);
    static Format AudioFormat(){return new Format{tag=1,channels=1,rate=16000,bytes=32000,align=2,bits=16,extra=0};}
    static void Emit(string type){Console.WriteLine("{\"type\":\""+type+"\"}");Console.Out.Flush();}
    static bool Down(int key){return (GetAsyncKeyState(key)&0x8000)!=0;}
    public static bool StartAllowed(bool down,bool previous,bool game){return down&&!previous&&game;}
    public static bool CancelRequired(bool escape,IntPtr current,IntPtr original){return escape||current!=original||current==IntPtr.Zero;}
    static IntPtr GameWindow(string title){
        IntPtr window=GetForegroundWindow();if(window==IntPtr.Zero)return IntPtr.Zero;
        StringBuilder text=new StringBuilder(512);GetWindowText(window,text,text.Capacity);
        if(text.ToString().IndexOf(title,StringComparison.OrdinalIgnoreCase)<0)return IntPtr.Zero;
        uint pid;GetWindowThreadProcessId(window,out pid);
        try {using(Process process=Process.GetProcessById((int)pid)){string p=process.ProcessName;return p.Equals("javaw",StringComparison.OrdinalIgnoreCase)||p.Equals("java",StringComparison.OrdinalIgnoreCase)?window:IntPtr.Zero;}}
        catch{return IntPtr.Zero;}
    }
    sealed class Capture:IDisposable {
        const int Length=640000;IntPtr handle,data,header;bool prepared=false;
        static readonly uint HeaderSize=(uint)Marshal.SizeOf(typeof(Header));
        public Capture(){
            try {
                Format f=AudioFormat();Check(waveInOpen(out handle,UInt32.MaxValue,ref f,IntPtr.Zero,IntPtr.Zero,0));
                data=Marshal.AllocHGlobal(Length);header=Marshal.AllocHGlobal((int)HeaderSize);
                Marshal.StructureToPtr(new Header{data=data,length=Length},header,false);
                Check(waveInPrepareHeader(handle,header,HeaderSize));prepared=true;
                Check(waveInAddBuffer(handle,header,HeaderSize));Check(waveInStart(handle));
            }catch{Dispose();throw;}
        }
        static void Check(uint code){if(code!=0)throw new AudioError(code);}
        public byte[] Finish(){
            Check(waveInReset(handle));Header h=(Header)Marshal.PtrToStructure(header,typeof(Header));
            int n=(int)Math.Min(h.recorded,(uint)Length);n-=n%2;byte[] pcm=new byte[n];Marshal.Copy(data,pcm,0,n);
            using(MemoryStream m=new MemoryStream())using(BinaryWriter w=new BinaryWriter(m)){
                w.Write(Encoding.ASCII.GetBytes("RIFF"));w.Write(n+36);w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
                w.Write(16);w.Write((ushort)1);w.Write((ushort)1);w.Write(16000);w.Write(32000);w.Write((ushort)2);w.Write((ushort)16);
                w.Write(Encoding.ASCII.GetBytes("data"));w.Write(n);w.Write(pcm);w.Flush();return m.ToArray();
            }
        }
        public void Dispose(){
            if(handle!=IntPtr.Zero){waveInReset(handle);if(prepared)waveInUnprepareHeader(handle,header,HeaderSize);waveInClose(handle);handle=IntPtr.Zero;}
            if(header!=IntPtr.Zero){Marshal.FreeHGlobal(header);header=IntPtr.Zero;}
            if(data!=IntPtr.Zero){Marshal.FreeHGlobal(data);data=IntPtr.Zero;}
        }
    }
    sealed class AudioError:Exception {public uint Code;public AudioError(uint code){Code=code;}}
    sealed class Rejection {public int Id;public string Reason;}
    static volatile bool stopping=false;static int cancel=0,admit=0,press=0;static Rejection reject=null;
    // Cues are played OUTSIDE the capture window (start cue only after the brain admitted this press and
    // before the device opens; end/cancel cues only after the device closed), so they are never recorded.
    // SetSound(false) is used by the offline self-test: it must never beep.
    static bool sound=true;
    public static void SetSound(bool on){sound=on;}
    static void Tone(int frequency,int durationMs){
        if(!sound||durationMs<=0)return;
        try{Console.Beep(frequency,durationMs);}catch{}   // no console / muted session: silence, never a crash
    }
    public static string RejectCue(string reason){return reason=="busy"?"double_low":reason=="no_scope"?"high_low":"single_low";}
    static void RejectTone(string reason){
        string cue=RejectCue(reason);
        if(cue=="double_low"){Tone(220,40);if(sound)Thread.Sleep(30);Tone(220,40);}
        else if(cue=="high_low"){Tone(600,40);Tone(220,70);}
        else Tone(220,90);
    }
    // Pure admission decision for the press handshake (unit-tested by SelfTest, no device touched).
    public const int Wait=0,Admit=1,Reject=2;
    public static bool Acknowledged(int received,int requested){return requested>0&&received==requested;}
    public static int AdmissionStep(bool accepted,bool cancelled,bool released,bool escaped,bool lostWindow){
        if(cancelled||released||escaped||lostWindow)return Reject;
        if(accepted)return Admit;
        return Wait;
    }
    public static void Run(int key,string title){
        if(key<1||key>254||String.IsNullOrWhiteSpace(title))throw new ArgumentException("Invalid hotkey settings");
        // EOF means the owning brain exited; release the microphone gracefully.
        Thread commands=new Thread(delegate(){string line;while((line=Console.ReadLine())!=null){
            if(line=="stop"){stopping=true;return;}
            int id;
            if(line.StartsWith("accept:")&&Int32.TryParse(line.Substring(7),out id))Interlocked.Exchange(ref admit,id);
            if(line.StartsWith("reject:")){string[] parts=line.Split(':');
                if(parts.Length==3&&Int32.TryParse(parts[1],out id))Interlocked.Exchange(ref reject,new Rejection{Id=id,Reason=parts[2]});}
            if(line=="cancel")Interlocked.Exchange(ref cancel,1);
        }stopping=true;});commands.IsBackground=true;commands.Start();
        Capture capture=null;IntPtr captureWindow=IntPtr.Zero,lastWindow=IntPtr.Zero;
        bool previous=Down(key),previousEscape=false;Stopwatch watch=new Stopwatch();Emit("ready");
        try {while(!stopping){
            bool down=Down(key),escape=Down(27),cancelNow=Interlocked.Exchange(ref cancel,0)!=0;IntPtr window=GameWindow(title);
            if(escape&&!previousEscape&&window!=IntPtr.Zero){Emit("cancel");cancelNow=true;}previousEscape=escape;
            if(lastWindow!=IntPtr.Zero&&window!=lastWindow)Emit("focus_lost");lastWindow=window;
            if(capture!=null){
                if(cancelNow||CancelRequired(escape,window,captureWindow)){capture.Dispose();capture=null;Tone(300,70);Emit("cancel");}
                else if(!down||watch.ElapsedMilliseconds>=20000){byte[] wav=capture.Finish();capture.Dispose();capture=null;
                    Tone(520,60);
                    Console.WriteLine("{\"type\":\"audio\",\"data\":\""+Convert.ToBase64String(wav)+"\"}");Console.Out.Flush();}
            }else if(StartAllowed(down,previous,window!=IntPtr.Zero)){
                int id=Interlocked.Increment(ref press);
                Console.WriteLine("{\"type\":\"start\",\"id\":"+id+"}");Console.Out.Flush();
                // Wait for the brain's admission decision BEFORE opening the device: a rejected press must
                // not be recorded and must not be announced by a success cue.
                bool admitted=false;string rejectedReason="cancelled";Stopwatch pending=new Stopwatch();pending.Start();
                while(!stopping&&pending.ElapsedMilliseconds<400){
                    bool ok=Acknowledged(Interlocked.Exchange(ref admit,0),id);
                    Rejection refusal=Interlocked.Exchange(ref reject,null);
                    bool refused=refusal!=null&&refusal.Id==id;if(refused)rejectedReason=refusal.Reason;
                    int step=AdmissionStep(ok,Interlocked.Exchange(ref cancel,0)!=0||refused,
                        !Down(key),Down(27),GameWindow(title)!=window);
                    if(step==Admit){admitted=true;break;}
                    if(step==Reject)break;
                    Thread.Sleep(5);
                }
                if(admitted){
                    Tone(880,60);
                    // Recheck after the cue too: no capture after key-up, cancellation, shutdown or focus loss.
                    if(stopping||AdmissionStep(true,Interlocked.Exchange(ref cancel,0)!=0,!Down(key),Down(27),GameWindow(title)!=window)!=Admit){RejectTone("cancelled");Emit("rejected");}
                    else try {capture=new Capture();captureWindow=window;watch.Restart();}
                    catch(AudioError e){Tone(220,90);Console.WriteLine("{\"type\":\"error\",\"code\":"+e.Code+"}");Console.Out.Flush();}
                }else {RejectTone(rejectedReason);Emit("rejected");}
            }
            previous=down;Thread.Sleep(15);
        }}finally{if(capture!=null)capture.Dispose();Emit("stopped");}
    }
    public static void Probe(){
        Format f=AudioFormat();IntPtr ignored;uint formatCode=waveInOpen(out ignored,UInt32.MaxValue,ref f,IntPtr.Zero,IntPtr.Zero,1);
        Console.WriteLine("{\"probe\":true,\"inputDevices\":"+waveInGetNumDevs()+",\"formatQueryCode\":"+formatCode+",\"recordingStarted\":false}");
    }
    public static void SelfTest(){
        // Pure gating only: no microphone, no device open, and the cue sound is disabled for the duration.
        bool wasSound=sound;sound=false;
        try {
            if(!StartAllowed(true,false,true)||StartAllowed(true,true,true)||StartAllowed(true,false,false)||StartAllowed(false,false,true)
                ||!CancelRequired(true,new IntPtr(1),new IntPtr(1))||!CancelRequired(false,new IntPtr(2),new IntPtr(1))
                ||!CancelRequired(false,IntPtr.Zero,new IntPtr(1))||CancelRequired(false,new IntPtr(1),new IntPtr(1)))throw new Exception("PTT gate failed");
            int admissionCases=0;
            Action<int,bool,bool,bool,bool,bool> expect=delegate(int want,bool accepted,bool cancelled,bool released,bool escaped,bool lostWindow){
                if(AdmissionStep(accepted,cancelled,released,escaped,lostWindow)!=want)throw new Exception("PTT admission failed");
                admissionCases++;
            };
            expect(Admit,true,false,false,false,false);
            expect(Reject,true,true,false,false,false);
            expect(Reject,true,false,true,false,false);
            expect(Reject,true,false,false,true,false);
            expect(Reject,true,false,false,false,true);
            expect(Reject,false,true,false,false,false);
            expect(Reject,false,false,true,false,false);
            expect(Reject,false,false,false,true,false);
            expect(Reject,false,false,false,false,true);
            expect(Wait,false,false,false,false,false);
            if(Acknowledged(0,0)||Acknowledged(1,2)||!Acknowledged(2,2))throw new Exception("PTT press identity failed");
            if(RejectCue("no_key")!="single_low"||RejectCue("busy")!="double_low"||RejectCue("no_scope")!="high_low")throw new Exception("PTT rejection cue failed");
            Console.WriteLine("{\"nativeGateCases\":8,\"admissionCases\":"+admissionCases+",\"soundDisabled\":true,\"passed\":true,\"recordingStarted\":false}");
        }finally{sound=wasSound;}
    }
}
