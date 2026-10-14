import pty, os, sys, fcntl, termios, struct, select, signal

if len(sys.argv) < 5:
    sys.exit(1)

try:
    cols = int(sys.argv[1])
except (ValueError, IndexError):
    cols = 80

try:
    rows = int(sys.argv[2])
except (ValueError, IndexError):
    rows = 24

cwd = sys.argv[3]
cmd = sys.argv[4]
args = sys.argv[4:]

try:
    master, slave = pty.openpty()
except Exception as e:
    sys.stderr.write(f"openpty failed: {e}\n")
    sys.exit(1)

try:
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
except Exception:
    pass

pid = os.fork()
if pid == 0:
    os.close(master)
    try:
        os.close(3)
    except OSError:
        pass
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except Exception:
        pass
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    try:
        if cwd and os.path.isdir(cwd):
            os.chdir(cwd)
    except Exception:
        pass
    try:
        os.execvp(cmd, args)
    except Exception as e:
        sys.stderr.write(f"execvp failed: {e}\n")
        sys.exit(127)
else:
    os.close(slave)
    control = 3
    control_buf = b''
    try:
        os.fstat(control)
    except OSError:
        control = None
    def stop_bridge(_sig, _frame):
        try:
            os.killpg(pid, signal.SIGHUP)
        except OSError:
            pass
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop_bridge)
    signal.signal(signal.SIGHUP, stop_bridge)
    for fd in [0, master] + ([control] if control is not None else []):
        try:
            fl = fcntl.fcntl(fd, fcntl.F_GETFL)
            fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
        except Exception:
            pass

    while True:
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid != 0:
                while True:
                    try:
                        d = os.read(master, 4096)
                        if not d:
                            break
                        sys.stdout.buffer.write(d)
                        sys.stdout.buffer.flush()
                    except Exception:
                        break
                sys.exit(os.waitstatus_to_exitcode(status))
        except ChildProcessError:
            break

        try:
            rlist, _, _ = select.select([0, master] + ([control] if control is not None else []), [], [], 0.05)
        except (select.error, OSError):
            break

        if 0 in rlist:
            try:
                data = os.read(0, 4096)
                if not data:
                    stop_bridge(0, None)
                    break
                os.write(master, data)
            except OSError:
                pass

        if control is not None and control in rlist:
            try:
                data = os.read(control, 4096)
                if not data:
                    control = None
                else:
                    control_buf = (control_buf + data)[-8192:]
                    while b'\n' in control_buf:
                        line, control_buf = control_buf.split(b'\n', 1)
                        try:
                            c, r = map(int, line.split())
                            if 2 <= c <= 500 and 2 <= r <= 500:
                                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
                        except (ValueError, OSError):
                            pass
            except OSError:
                control = None

        if master in rlist:
            try:
                data = os.read(master, 4096)
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except OSError:
                break
