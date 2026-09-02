"""
Patch the api-server's baked compose so GitLab boots without the six services no
TAC task or evaluator ever touches, and with a worker count this box can fork.

Measured basis: the 175 tasks and their evaluators reference only port 8929 and
git. Nothing references prometheus (9090), alertmanager (9093) or gitlab-kas.
Puma defaults its worker count from CPU count (12 here), so it forks 10 workers
of roughly half a gigabyte each on a 12 GB VM.

Usage: python gitlab_tune.py apply | revert
"""
import subprocess, sys

TUNING = """        prometheus_monitoring['enable'] = false
        gitlab_kas['enable'] = false
        puma['worker_processes'] = 2
        sidekiq['concurrency'] = 5
"""
ANCHOR = "        gitlab_rails['gitlab_shell_ssh_port'] = 2424\n"
PATH = "/workspace/docker-compose.yml"


def read() -> str:
    r = subprocess.run(["docker", "exec", "api-server", "cat", PATH],
                       capture_output=True, text=True, check=True)
    return r.stdout


def write(text: str) -> None:
    subprocess.run(["docker", "exec", "-i", "api-server", "sh", "-c", f"cat > {PATH}"],
                   input=text, text=True, check=True)


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    s = read()
    if mode == "apply":
        if TUNING.strip().splitlines()[0] in s:
            print("already applied")
            return 0
        assert ANCHOR in s, "anchor line not found"
        # pull_policy: always is what stalls compose on the 11 GB image; the
        # image is local and pinned by tag, so checking the registry buys
        # nothing and costs a hang.
        s = s.replace(ANCHOR, ANCHOR + TUNING, 1).replace(
            "    pull_policy: always\n", "    pull_policy: never\n")
        write(s)
        print("applied")
    elif mode == "revert":
        for line in TUNING.splitlines(keepends=True):
            s = s.replace(line, "")
        s = s.replace("    pull_policy: never\n", "    pull_policy: always\n")
        write(s)
        print("reverted")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
