import pty, os, sys, fcntl, termios, struct, select

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
    for fd in [0, master]:
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
            rlist, _, _ = select.select([0, master], [], [], 0.05)
        except (select.error, OSError):
            break

        if 0 in rlist:
            try:
                data = os.read(0, 4096)
                if not data:
                    break
                os.write(master, data)
            except OSError:
                pass

        if master in rlist:
            try:
                data = os.read(master, 4096)
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except OSError:
                break
