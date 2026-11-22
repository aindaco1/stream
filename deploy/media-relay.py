"""Connect a media job's private loopback to its single mounted input socket."""
import asyncio
import contextlib
import ctypes
import resource
import sys


async def pipe(reader, writer):
    while chunk := await reader.read(65536):
        writer.write(chunk)
        await writer.drain()
    writer.write_eof()


async def relay(reader, writer):
    upstream = None
    tasks = []
    try:
        source, upstream = await asyncio.open_unix_connection("/input.sock")
        tasks = [asyncio.create_task(pipe(reader, upstream)), asyncio.create_task(pipe(source, writer))]
        await asyncio.gather(*tasks)
    except (ConnectionError, OSError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for connection in (writer, upstream):
            if connection:
                connection.close()
                with contextlib.suppress(OSError):
                    await connection.wait_closed()


async def main():
    if sys.argv[1] not in ("ffmpeg", "ffprobe"):
        raise ValueError("Unknown media executable")
    # A codec and its descendants can never gain privileges from set-ID binaries.
    if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Could not lock media privileges")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    async with await asyncio.start_server(relay, "127.0.0.1", 17823):
        child = await asyncio.create_subprocess_exec("/usr/bin/" + sys.argv[1], *sys.argv[2:])
        return await child.wait()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
