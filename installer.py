# blxstncord updater - a single dark GUI that installs the Device Detector plugin and
# restarts Discord, with everything running INSIDE this program. No install.bat, no console
# window, nothing left on your desktop. Build it into one .exe with build.bat (PyInstaller).

import os
import base64
import shutil
import time
import queue
import threading
import subprocess
import tkinter as tk
from tkinter import scrolledtext

APP_NAME = "blxstncord"
PLUGIN_NAME = "device-detector.js"
PLUGIN_VERSION = "2.0.1"

# ---- the plugin itself, embedded so the exe needs no other files ----
PLUGIN_B64 = (
    "Ly8gRGV2aWNlIERldGVjdG9yIHYyLjAuMSAgLSAgZGV2aWNlIC8gcGxhdGZvcm0gaW5kaWNhdG9yLCBidWlsdCB0aGUgd2F5IFZl"
    "bmNvcmQncyBQbGF0Zm9ybUluZGljYXRvcnMgd29ya3MuCi8vCi8vIFNob3dzIHdoaWNoIGRldmljZSBlYWNoIHVzZXIgaXMgb25s"
    "aW5lIG9uIC0gUEMgKGRlc2t0b3AgYXBwKSwgUGhvbmUgKG1vYmlsZSksIEJyb3dzZXIgKHdlYikgb3IKLy8gQ29uc29sZSAoWGJv"
    "eCAvIFBsYXlTdGF0aW9uKSAtIGFzIGEgc21hbGwgaWNvbiBvbiB0aGVpciBhdmF0YXIsIGluIHRoZSBtZW1iZXIgbGlzdCBhbmQg"
    "dGhlIERNIGxpc3QuCi8vCi8vIERBVEEgU09VUkNFOiBEaXNjb3JkJ3Mgb3duIFByZXNlbmNlU3RvcmUsIHRoZSBleGFjdCBzdG9y"
    "ZSBWZW5jb3JkIHJlYWRzLiBJdCBpcyBrZXB0IGxpdmUgdGhyb3VnaCB0aGUKLy8gc3RvcmUncyBvd24gY2hhbmdlIGxpc3RlbmVy"
    "IGFuZCwgYXMgYSBiYWNrdXAsIGEgc3Vic2NyaXB0aW9uIHRvIHRoZSBGbHV4IGRpc3BhdGNoZXIncyBQUkVTRU5DRSB1cGRhdGVz"
    "LgovLwovLyBIQVJEIExJTUlUIChpZGVudGljYWwgdG8gVmVuY29yZCBhbmQgZXZlcnkgb3RoZXIgY2xpZW50IG1vZCk6IGl0IGNh"
    "biBvbmx5IHNob3cgd2hhdCBEaXNjb3JkIHNlbmRzIHRvCi8vIHlvdXIgY2xpZW50LiBEaXNjb3JkIHNlbmRzIE5PIGRldmljZSBm"
    "b3IgYW55b25lIHdobyBhcHBlYXJzIG9mZmxpbmUgLSBpbmNsdWRpbmcgdXNlcnMgc2V0IHRvIEludmlzaWJsZS4KLy8gU28gaW52"
    "aXNpYmxlIHVzZXJzIHNob3cgbm90aGluZyBoZXJlLCBleGFjdGx5IGFzIHRoZXkgc2hvdyBub3RoaW5nIGluIFZlbmNvcmQuIFRo"
    "aXMgaXMgYSBEaXNjb3JkCi8vIHNlcnZlci1zaWRlIHJ1bGUsIG5vdCBhIGdhcCBpbiB0aGUgcGx1Z2luLgoKYmx4c3RuY29yZC5k"
    "ZWZpbmVQbHVnaW4oewogICAgaWQ6ICJkZXZpY2UtZGV0ZWN0b3IiLAogICAgbmFtZTogIkRldmljZSBEZXRlY3RvciIsCiAgICBk"
    "ZXNjcmlwdGlvbjogIlNob3dzIGVhY2ggdXNlcidzIGRldmljZSAoUEMgLyBwaG9uZSAvIGJyb3dzZXIgLyBjb25zb2xlKSBvbiB0"
    "aGVpciBhdmF0YXIsIGxpa2UgVmVuY29yZCdzIHBsYXRmb3JtIGluZGljYXRvcnMuIFJlYWRzIERpc2NvcmQncyBQcmVzZW5jZVN0"
    "b3JlOyBpbnZpc2libGUgdXNlcnMgcmVwb3J0IG5vIGRldmljZS4iLAogICAgYXV0aG9yOiAiYmx4c3RuY29yZCIsCiAgICB2ZXJz"
    "aW9uOiAiMi4wLjEiLAogICAgZW5hYmxlZEJ5RGVmYXVsdDogdHJ1ZSwKICAgIHdlYnBhY2s6IHRydWUsCgogICAgc3RhcnQoYXBp"
    "KSB7CiAgICAgICAgY29uc3QgTlMgPSAiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciOwogICAgICAgIGNvbnN0IFNOT1cgPSAv"
    "XlxkezE3LDIwfSQvOwogICAgICAgIGNvbnN0IFNUQVRVU19TRUwgPSAncmVjdFttYXNrKj0ic3ZnLW1hc2stc3RhdHVzIl0nOwog"
    "ICAgICAgIGNvbnN0IE9SREVSID0gWyJlbWJlZGRlZCIsICJtb2JpbGUiLCAiZGVza3RvcCIsICJ3ZWIiXTsgICAgICAgIC8vIHdo"
    "aWNoIGljb24gd2lucyB3aGVuIG9uIHNldmVyYWwgZGV2aWNlcwogICAgICAgIGNvbnN0IExBQkVMID0geyBkZXNrdG9wOiAiUEMi"
    "LCBtb2JpbGU6ICJQaG9uZSIsIHdlYjogIkJyb3dzZXIiLCBlbWJlZGRlZDogIkNvbnNvbGUiIH07CiAgICAgICAgY29uc3QgU1RB"
    "VFVTX0NPTE9SID0geyBvbmxpbmU6ICIjMjNhNTU5IiwgaWRsZTogIiNmMGIyMzIiLCBkbmQ6ICIjZjIzZjQyIiwgc3RyZWFtaW5n"
    "OiAiIzU5MzY5NSIgfTsKICAgICAgICBjb25zdCBTVEFUVVNfTkFNRSA9IHsgb25saW5lOiAiT25saW5lIiwgaWRsZTogIklkbGUi"
    "LCBkbmQ6ICJEbyBOb3QgRGlzdHVyYiIsIHN0cmVhbWluZzogIlN0cmVhbWluZyIgfTsKICAgICAgICBjb25zdCBJQ09OUyA9IHsg"
    "ICAvLyBNYXRlcmlhbCBpY29ucywgMjR4MjQKICAgICAgICAgICAgZGVza3RvcDogIk0yMSAySDNjLTEuMSAwLTIgLjktMiAydjEy"
    "YzAgMS4xLjkgMiAyIDJoN3YySDh2Mmg4di0yaC0ydi0yaDdjMS4xIDAgMi0uOSAyLTJWNGMwLTEuMS0uOS0yLTItMnptMCAxNEgz"
    "VjRoMTh2MTJ6IiwKICAgICAgICAgICAgbW9iaWxlOiAiTTE3IDEuMDFMNyAxYy0xLjEgMC0yIC45LTIgMnYxOGMwIDEuMS45IDIg"
    "MiAyaDEwYzEuMSAwIDItLjkgMi0yVjNjMC0xLjEtLjktMS45OS0yLTEuOTl6TTE3IDE5SDdWNWgxMHYxNHoiLAogICAgICAgICAg"
    "ICB3ZWI6ICJNMTIgMkM2LjQ4IDIgMiA2LjQ4IDIgMTJzNC40OCAxMCAxMCAxMCAxMC00LjQ4IDEwLTEwUzE3LjUyIDIgMTIgMnpt"
    "LTEgMTcuOTNjLTMuOTUtLjQ5LTctMy44NS03LTcuOTMgMC0uNjIuMDgtMS4yMS4yMS0xLjc5TDkgMTV2MWMwIDEuMS45IDIgMiAy"
    "djEuOTN6bTYuOS0yLjU0Yy0uMjYtLjgxLTEtMS4zOS0xLjktMS4zOWgtMXYtM2MwLS41NS0uNDUtMS0xLTFIOHYtMmgyYy41NSAw"
    "IDEtLjQ1IDEtMVY3aDJjMS4xIDAgMi0uOSAyLTJ2LS40MWMyLjkzIDEuMTkgNSA0LjA2IDUgNy40MSAwIDIuMDgtLjggMy45Ny0y"
    "LjEgNS4zOXoiLAogICAgICAgICAgICBlbWJlZGRlZDogIk0yMSA2SDNjLTEuMSAwLTIgLjktMiAydjhjMCAxLjEuOSAyIDIgMmgx"
    "OGMxLjEgMCAyLS45IDItMlY4YzAtMS4xLS45LTItMi0yem0tMTAgN0g4djNINnYtM0gzdi0yaDNWOGgydjNoM3Yyem00LjUgMmMt"
    "LjgzIDAtMS41LS42Ny0xLjUtMS41cy42Ny0xLjUgMS41LTEuNSAxLjUuNjcgMS41IDEuNS0uNjcgMS41LTEuNSAxLjV6bTQtM2Mt"
    "LjgzIDAtMS41LS42Ny0xLjUtMS41UzE4LjY3IDkgMTkuNSA5czEuNS42NyAxLjUgMS41LS42NyAxLjUtMS41IDEuNXoiCiAgICAg"
    "ICAgfTsKICAgICAgICBjb25zdCBnZXRTID0gKGssIGQpID0+IGFwaS5zZXR0aW5ncy5nZXQoaywgZCk7CiAgICAgICAgbGV0IHN0"
    "b3BwZWQgPSBmYWxzZTsKICAgICAgICBjb25zdCBzdGF0cyA9IHsgZG90czogMCwgcGFpbnRlZDogMCwgbm9JZDogMCwgZXJyb3Jz"
    "OiAwLCBsYXN0RXJyOiAiIiB9OwoKICAgICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09IGRhdGE6IERpc2NvcmQn"
    "cyBQcmVzZW5jZVN0b3JlID09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgICAgICBsZXQgcHJlc2VuY2UgPSBudWxsOwoK"
    "ICAgICAgICBmdW5jdGlvbiBmaW5kU3RvcmUoKSB7CiAgICAgICAgICAgIGlmIChwcmVzZW5jZSB8fCBzdG9wcGVkKSByZXR1cm47"
    "CiAgICAgICAgICAgIHRyeSB7CiAgICAgICAgICAgICAgICBwcmVzZW5jZSA9IGFwaS53ZWJwYWNrLmZpbmRCeSgicHJlc2VuY2Ut"
    "c3RvcmUiLCBbImlzTW9iaWxlT25saW5lIl0sCiAgICAgICAgICAgICAgICAgICAgbyA9PiB0eXBlb2Ygby5nZXRTdGF0dXMgPT09"
    "ICJmdW5jdGlvbiIgJiYgdHlwZW9mIG8uaXNNb2JpbGVPbmxpbmUgPT09ICJmdW5jdGlvbiIpIHx8IG51bGw7CiAgICAgICAgICAg"
    "IH0gY2F0Y2ggKGUpIHsgYXBpLmxvZygiUHJlc2VuY2VTdG9yZSBzZWFyY2ggZXJyb3I6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwg"
    "ZSkpOyB9CiAgICAgICAgICAgIGlmICghcHJlc2VuY2UpIHsgdHJ5IHsgcHJlc2VuY2UgPSBhcGkud2VicGFjay5maW5kQnlQcm9w"
    "cyhbImlzTW9iaWxlT25saW5lIl0sICJnZXRTdGF0dXMiLCAiaXNNb2JpbGVPbmxpbmUiKSB8fCBudWxsOyB9IGNhdGNoIHsgfSB9"
    "CiAgICAgICAgICAgIGlmICghcHJlc2VuY2UpIHsgdHJ5IHsgcHJlc2VuY2UgPSBhcGkud2VicGFjay5maW5kKG8gPT4gbyAmJiB0"
    "eXBlb2Ygby5nZXRTdGF0dXMgPT09ICJmdW5jdGlvbiIgJiYgdHlwZW9mIG8uaXNNb2JpbGVPbmxpbmUgPT09ICJmdW5jdGlvbiIg"
    "JiYgdHlwZW9mIG8uZ2V0U3RhdGUgPT09ICJmdW5jdGlvbiIsIDEpIHx8IG51bGw7IH0gY2F0Y2ggeyB9IH0KICAgICAgICAgICAg"
    "aWYgKHByZXNlbmNlKSB7CiAgICAgICAgICAgICAgICBhcGkubG9nKCJQcmVzZW5jZVN0b3JlOiBmb3VuZCIpOwogICAgICAgICAg"
    "ICAgICAgdHJ5IHsKICAgICAgICAgICAgICAgICAgICBwcmVzZW5jZS5hZGRDaGFuZ2VMaXN0ZW5lcihzY2hlZHVsZSk7CiAgICAg"
    "ICAgICAgICAgICAgICAgYXBpLmNsZWFudXAoKCkgPT4geyB0cnkgeyBwcmVzZW5jZS5yZW1vdmVDaGFuZ2VMaXN0ZW5lcihzY2hl"
    "ZHVsZSk7IH0gY2F0Y2ggeyB9IH0pOwogICAgICAgICAgICAgICAgfSBjYXRjaCB7IH0KICAgICAgICAgICAgICAgIHNjaGVkdWxl"
    "KCk7CiAgICAgICAgICAgIH0KICAgICAgICB9CgogICAgICAgIC8vIFRoZSBkZXZpY2UocykgKyBzdGF0dXMgRGlzY29yZCBpcyBy"
    "ZXBvcnRpbmcgZm9yIHRoaXMgdXNlci4gbnVsbCA9IHNob3cgbm90aGluZyAobGVhdmUgRGlzY29yZCdzIGRvdCkuCiAgICAgICAg"
    "ZnVuY3Rpb24gZGV2aWNlSW5mbyhpZCkgewogICAgICAgICAgICBpZiAoIXByZXNlbmNlKSByZXR1cm4gbnVsbDsKICAgICAgICAg"
    "ICAgbGV0IHN0YXR1czsKICAgICAgICAgICAgdHJ5IHsgc3RhdHVzID0gcHJlc2VuY2UuZ2V0U3RhdHVzKGlkKTsgfSBjYXRjaCB7"
    "IH0KICAgICAgICAgICAgaWYgKCFzdGF0dXMgfHwgc3RhdHVzID09PSAib2ZmbGluZSIgfHwgc3RhdHVzID09PSAiaW52aXNpYmxl"
    "IikgcmV0dXJuIG51bGw7ICAgLy8gRGlzY29yZCBzZW5kcyBubyBkZXZpY2UgZm9yIHRoZXNlCiAgICAgICAgICAgIGxldCBjczsK"
    "ICAgICAgICAgICAgdHJ5IHsgY3MgPSBwcmVzZW5jZS5nZXRDbGllbnRTdGF0dXMgPyBwcmVzZW5jZS5nZXRDbGllbnRTdGF0dXMo"
    "aWQpIDogbnVsbDsgfSBjYXRjaCB7IH0KICAgICAgICAgICAgaWYgKCFjcykgeyB0cnkgeyBjb25zdCBzID0gcHJlc2VuY2UuZ2V0"
    "U3RhdGUgJiYgcHJlc2VuY2UuZ2V0U3RhdGUoKTsgY3MgPSBzICYmIHMuY2xpZW50U3RhdHVzZXMgJiYgcy5jbGllbnRTdGF0dXNl"
    "c1tpZF07IH0gY2F0Y2ggeyB9IH0KICAgICAgICAgICAgY29uc3QgZGV2aWNlcyA9IE9SREVSLmZpbHRlcihkID0+IGNzICYmIGNz"
    "W2RdKTsKICAgICAgICAgICAgaWYgKCFkZXZpY2VzLmxlbmd0aCkgcmV0dXJuIG51bGw7ICAgLy8gb25saW5lIGJ1dCBubyBwbGF0"
    "Zm9ybSByZXBvcnRlZCAtPiBsZWF2ZSBEaXNjb3JkJ3Mgb3duIGRvdCBhbG9uZQogICAgICAgICAgICByZXR1cm4geyBzdGF0dXMs"
    "IGRldmljZXMgfTsKICAgICAgICB9CgogICAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT0gbGl2ZSB1cGRhdGVz"
    "OiBGbHV4IGRpc3BhdGNoZXIgKGJhY2t1cCkgPT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICAgICAgIGNvbnN0IGlzRGlz"
    "cCA9IG8gPT4gISFvICYmICh0eXBlb2YgbyA9PT0gIm9iamVjdCIgfHwgdHlwZW9mIG8gPT09ICJmdW5jdGlvbiIpICYmCiAgICAg"
    "ICAgICAgIHR5cGVvZiBvLnN1YnNjcmliZSA9PT0gImZ1bmN0aW9uIiAmJiB0eXBlb2Ygby51bnN1YnNjcmliZSA9PT0gImZ1bmN0"
    "aW9uIiAmJiB0eXBlb2Ygby5kaXNwYXRjaCA9PT0gImZ1bmN0aW9uIjsKICAgICAgICBsZXQgZGlzcGF0Y2hlcnMgPSBbXTsKICAg"
    "ICAgICB0cnkgewogICAgICAgICAgICBjb25zdCBvbmUgPSBhcGkud2VicGFjay5maW5kKG8gPT4gaXNEaXNwKG8pLCAxKTsKICAg"
    "ICAgICAgICAgZGlzcGF0Y2hlcnMgPSBvbmUgPyBbb25lXSA6IChhcGkud2VicGFjay5maW5kQWxsKG8gPT4gaXNEaXNwKG8pLCA2"
    "LCAzKSB8fCBbXSk7CiAgICAgICAgfSBjYXRjaCB7IH0KICAgICAgICBjb25zdCBvblByZXMgPSAoKSA9PiBzY2hlZHVsZSgpOwog"
    "ICAgICAgIGNvbnN0IFBSRVNfRVZFTlRTID0gWyJQUkVTRU5DRV9VUERBVEVTIiwgIlBSRVNFTkNFX1VQREFURSJdOwogICAgICAg"
    "IGRpc3BhdGNoZXJzLmZvckVhY2goZCA9PiB7CiAgICAgICAgICAgIGZvciAoY29uc3QgdCBvZiBQUkVTX0VWRU5UUykgeyB0cnkg"
    "eyBkLnN1YnNjcmliZSh0LCBvblByZXMpOyB9IGNhdGNoIHsgfSB9CiAgICAgICAgICAgIGFwaS5jbGVhbnVwKCgpID0+IHsgZm9y"
    "IChjb25zdCB0IG9mIFBSRVNfRVZFTlRTKSB7IHRyeSB7IGQudW5zdWJzY3JpYmUodCwgb25QcmVzKTsgfSBjYXRjaCB7IH0gfSB9"
    "KTsKICAgICAgICB9KTsKCiAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PSBmaW5kIHdoaWNoIHVzZXIgYSBz"
    "dGF0dXMgZG90IGJlbG9uZ3MgdG8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICAgICAgIGZ1bmN0aW9uIGZpYmVyT2Yo"
    "ZWwpIHsKICAgICAgICAgICAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKGVsKSkgaWYgKGsuc3RhcnRzV2l0aCgiX19yZWFj"
    "dEZpYmVyJCIpIHx8IGsuc3RhcnRzV2l0aCgiX19yZWFjdEludGVybmFsSW5zdGFuY2UkIikpIHJldHVybiBlbFtrXTsKICAgICAg"
    "ICAgICAgcmV0dXJuIG51bGw7CiAgICAgICAgfQogICAgICAgIGZ1bmN0aW9uIHJlY2lwaWVudElkKGNoKSB7ICAgLy8gYSAxOjEg"
    "RE0gY2hhbm5lbCAtPiBpdHMgb25lIHJlY2lwaWVudCAoZ3JvdXAgRE1zLCB0eXBlIDMsIGFyZSBza2lwcGVkKQogICAgICAgICAg"
    "ICBpZiAoIWNoIHx8IHR5cGVvZiBjaCAhPT0gIm9iamVjdCIgfHwgY2gudHlwZSA9PT0gMykgcmV0dXJuIG51bGw7CiAgICAgICAg"
    "ICAgIGNvbnN0IGxpc3QgPSBjaC5yZWNpcGllbnRzIHx8IGNoLnJhd1JlY2lwaWVudHM7CiAgICAgICAgICAgIGlmIChBcnJheS5p"
    "c0FycmF5KGxpc3QpICYmIGxpc3QubGVuZ3RoID09PSAxKSB7CiAgICAgICAgICAgICAgICBjb25zdCByID0gbGlzdFswXSwgaWQg"
    "PSB0eXBlb2YgciA9PT0gInN0cmluZyIgPyByIDogKHIgJiYgci5pZCk7CiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGlkID09"
    "PSAic3RyaW5nIiAmJiBTTk9XLnRlc3QoaWQpKSByZXR1cm4gaWQ7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgaWYgKHR5cGVv"
    "ZiBjaC5yZWNpcGllbnRJZCA9PT0gInN0cmluZyIgJiYgU05PVy50ZXN0KGNoLnJlY2lwaWVudElkKSkgcmV0dXJuIGNoLnJlY2lw"
    "aWVudElkOwogICAgICAgICAgICByZXR1cm4gbnVsbDsKICAgICAgICB9CiAgICAgICAgZnVuY3Rpb24gaWRGcm9tRmliZXIoZWwp"
    "IHsKICAgICAgICAgICAgbGV0IGYgPSBmaWJlck9mKGVsKTsKICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGYgJiYgaSA8IDQw"
    "OyBpKyssIGYgPSBmLnJldHVybikgewogICAgICAgICAgICAgICAgY29uc3QgcCA9IGYubWVtb2l6ZWRQcm9wczsKICAgICAgICAg"
    "ICAgICAgIGlmICghcCB8fCB0eXBlb2YgcCAhPT0gIm9iamVjdCIpIGNvbnRpbnVlOwogICAgICAgICAgICAgICAgZm9yIChjb25z"
    "dCB4IG9mIFtwLnVzZXIgJiYgcC51c2VyLmlkLCBwLnVzZXJJZCwgcC5tZW1iZXIgJiYgcC5tZW1iZXIudXNlcklkLCBwLmF1dGhv"
    "ciAmJiBwLmF1dGhvci5pZCwKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcC51c2VyX2lkLCBwLnJlY2lwaWVudElk"
    "LCByZWNpcGllbnRJZChwLmNoYW5uZWwpLCByZWNpcGllbnRJZChwKV0pCiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB4"
    "ID09PSAic3RyaW5nIiAmJiBTTk9XLnRlc3QoeCkpIHJldHVybiB4OwogICAgICAgICAgICB9CiAgICAgICAgICAgIHJldHVybiBu"
    "dWxsOwogICAgICAgIH0KICAgICAgICBmdW5jdGlvbiBpZEZyb21JbWcoc3ZnKSB7CiAgICAgICAgICAgIGNvbnN0IGltZyA9IHN2"
    "Zy5xdWVyeVNlbGVjdG9yKCJpbWdbc3JjXSIpOwogICAgICAgICAgICBjb25zdCBtID0gaW1nICYmIC9cLyg/OnVzZXJzfGF2YXRh"
    "cnMpXC8oXGR7MTcsMjB9KVwvLy5leGVjKGltZy5zcmMpOwogICAgICAgICAgICByZXR1cm4gbSA/IG1bMV0gOiBudWxsOwogICAg"
    "ICAgIH0KCiAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PSBkcmF3IHRoZSBpY29uIG92ZXIgdGhlIHN0YXR1"
    "cyBkb3QgPT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICAgICAgIGFwaS5hZGRTdHlsZSgncmVjdFtkYXRhLWJseC1oaWRl"
    "XXtkaXNwbGF5Om5vbmUhaW1wb3J0YW50fScpOwogICAgICAgIGNvbnN0IG51bSA9IChlbCwgYSkgPT4gcGFyc2VGbG9hdChlbC5n"
    "ZXRBdHRyaWJ1dGUoYSkpOwogICAgICAgIGNvbnN0IGJhZGdlT2YgPSByZWN0ID0+IHsgY29uc3QgbiA9IHJlY3QucGFyZW50Tm9k"
    "ZTsgcmV0dXJuIG4gPyBbLi4ubi5jaGlsZHJlbl0uZmluZChjID0+IGMuaGFzQXR0cmlidXRlICYmIGMuaGFzQXR0cmlidXRlKCJk"
    "YXRhLWJseC1kZXYiKSkgOiBudWxsOyB9OwogICAgICAgIGZ1bmN0aW9uIHJlc3RvcmUocmVjdCkgeyByZWN0LnJlbW92ZUF0dHJp"
    "YnV0ZSgiZGF0YS1ibHgtaGlkZSIpOyBjb25zdCBnID0gYmFkZ2VPZihyZWN0KTsgaWYgKGcpIGcucmVtb3ZlKCk7IH0KCiAgICAg"
    "ICAgZnVuY3Rpb24gcGFpbnQocmVjdCwgaW5mKSB7CiAgICAgICAgICAgIGxldCB4ID0gbnVtKHJlY3QsICJ4IiksIHkgPSBudW0o"
    "cmVjdCwgInkiKSwgdyA9IG51bShyZWN0LCAid2lkdGgiKSwgaCA9IG51bShyZWN0LCAiaGVpZ2h0Iik7CiAgICAgICAgICAgIGlm"
    "ICghW3gsIHksIHcsIGhdLmV2ZXJ5KE51bWJlci5pc0Zpbml0ZSkpIHsgdHJ5IHsgY29uc3QgYiA9IHJlY3QuZ2V0QkJveCgpOyB4"
    "ID0gYi54OyB5ID0gYi55OyB3ID0gYi53aWR0aDsgaCA9IGIuaGVpZ2h0OyB9IGNhdGNoIHsgcmV0dXJuOyB9IH0KICAgICAgICAg"
    "ICAgY29uc3QgZGV2ID0gaW5mLmRldmljZXNbMF07CiAgICAgICAgICAgIGNvbnN0IGNvbG9yID0gZ2V0UygiY29sb3IiLCB0cnVl"
    "KSA/IChTVEFUVVNfQ09MT1JbaW5mLnN0YXR1c10gfHwgU1RBVFVTX0NPTE9SLm9ubGluZSkgOiBTVEFUVVNfQ09MT1Iub25saW5l"
    "OwogICAgICAgICAgICBjb25zdCBjeCA9IHggKyB3IC8gMiwgY3kgPSB5ICsgaCAvIDIsIGJhc2UgPSBNYXRoLm1heCh3LCBoKTsK"
    "ICAgICAgICAgICAgY29uc3Qgc2lnID0gW2RldiwgaW5mLmRldmljZXMuam9pbigiKyIpLCBjb2xvciwgY3gsIGN5LCBiYXNlXS5q"
    "b2luKCJ8Iik7CgogICAgICAgICAgICBsZXQgZyA9IGJhZGdlT2YocmVjdCk7CiAgICAgICAgICAgIGlmIChnICYmIGcuZ2V0QXR0"
    "cmlidXRlKCJkYXRhLXNpZyIpID09PSBzaWcpIHsgcmVjdC5zZXRBdHRyaWJ1dGUoImRhdGEtYmx4LWhpZGUiLCAiMSIpOyByZXR1"
    "cm47IH0KICAgICAgICAgICAgaWYgKCFnKSB7IGcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50TlMoTlMsICJnIik7IGcuc2V0QXR0"
    "cmlidXRlKCJkYXRhLWJseC1kZXYiLCAiMSIpOyByZWN0LmFmdGVyKGcpOyB9CiAgICAgICAgICAgIGcuc2V0QXR0cmlidXRlKCJk"
    "YXRhLXNpZyIsIHNpZyk7CiAgICAgICAgICAgIGcucmVwbGFjZUNoaWxkcmVuKCk7CgogICAgICAgICAgICBjb25zdCB0aXRsZSA9"
    "IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhOUywgInRpdGxlIik7CiAgICAgICAgICAgIHRpdGxlLnRleHRDb250ZW50ID0gaW5m"
    "LmRldmljZXMubWFwKGQgPT4gTEFCRUxbZF0pLmpvaW4oIiArICIpICsgIiBcdTAwYjcgIiArIChTVEFUVVNfTkFNRVtpbmYuc3Rh"
    "dHVzXSB8fCBpbmYuc3RhdHVzKTsKCiAgICAgICAgICAgIGNvbnN0IHIgPSBiYXNlICogMC44MiwgcyA9IHIgKiAxLjM1OwogICAg"
    "ICAgICAgICBjb25zdCBiZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhOUywgImNpcmNsZSIpOwogICAgICAgICAgICBiZy5z"
    "ZXRBdHRyaWJ1dGUoImN4IiwgY3gpOyBiZy5zZXRBdHRyaWJ1dGUoImN5IiwgY3kpOyBiZy5zZXRBdHRyaWJ1dGUoInIiLCByKTsK"
    "ICAgICAgICAgICAgYmcuc2V0QXR0cmlidXRlKCJzdHlsZSIsICJmaWxsOnZhcigtLWJhY2tncm91bmQtYmFzZS1sb3dlc3QsIzFl"
    "MWYyMikiKTsKICAgICAgICAgICAgY29uc3QgaWNvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudE5TKE5TLCAicGF0aCIpOwogICAg"
    "ICAgICAgICBpY28uc2V0QXR0cmlidXRlKCJkIiwgSUNPTlNbZGV2XSk7IGljby5zZXRBdHRyaWJ1dGUoImZpbGwiLCBjb2xvcik7"
    "CiAgICAgICAgICAgIGljby5zZXRBdHRyaWJ1dGUoInRyYW5zZm9ybSIsICJ0cmFuc2xhdGUoIiArIChjeCAtIHMgLyAyKSArICIg"
    "IiArIChjeSAtIHMgLyAyKSArICIpIHNjYWxlKCIgKyAocyAvIDI0KSArICIpIik7CgogICAgICAgICAgICBnLmFwcGVuZCh0aXRs"
    "ZSwgYmcsIGljbyk7CiAgICAgICAgICAgIHJlY3Quc2V0QXR0cmlidXRlKCJkYXRhLWJseC1oaWRlIiwgIjEiKTsKICAgICAgICB9"
    "CgogICAgICAgIGZ1bmN0aW9uIHNjYW4oKSB7CiAgICAgICAgICAgIGlmIChzdG9wcGVkKSByZXR1cm47CiAgICAgICAgICAgIGxl"
    "dCBkb3RzID0gMCwgcGFpbnRlZCA9IDAsIG5vSWQgPSAwOwogICAgICAgICAgICBmb3IgKGNvbnN0IHJlY3Qgb2YgZG9jdW1lbnQu"
    "cXVlcnlTZWxlY3RvckFsbChTVEFUVVNfU0VMKSkgewogICAgICAgICAgICAgICAgY29uc3Qgc3ZnID0gcmVjdC5vd25lclNWR0Vs"
    "ZW1lbnQ7CiAgICAgICAgICAgICAgICBpZiAoIXN2ZyB8fCAhc3ZnLnF1ZXJ5U2VsZWN0b3IoImZvcmVpZ25PYmplY3QiKSkgY29u"
    "dGludWU7ICAgLy8gYXZhdGFyIGRvdHMgb25seSwgbm90IHN0YXR1cy1tZW51IGljb25zCiAgICAgICAgICAgICAgICBkb3RzKys7"
    "CiAgICAgICAgICAgICAgICB0cnkgeyAgIC8vIG9uZSBicm9rZW4gYXZhdGFyIG11c3QgbmV2ZXIgc3RvcCB0aGUgcmVzdCBvZiB0"
    "aGUgbGlzdAogICAgICAgICAgICAgICAgICAgIGNvbnN0IGlkID0gaWRGcm9tSW1nKHN2ZykgfHwgaWRGcm9tRmliZXIocmVjdCk7"
    "CiAgICAgICAgICAgICAgICAgICAgaWYgKCFpZCkgeyBub0lkKys7IGNvbnRpbnVlOyB9CiAgICAgICAgICAgICAgICAgICAgY29u"
    "c3QgaW5mID0gZGV2aWNlSW5mbyhpZCk7CiAgICAgICAgICAgICAgICAgICAgaWYgKGluZikgeyBwYWludChyZWN0LCBpbmYpOyBw"
    "YWludGVkKys7IH0gZWxzZSByZXN0b3JlKHJlY3QpOwogICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkgeyBzdGF0cy5lcnJvcnMr"
    "Kzsgc3RhdHMubGFzdEVyciA9IChlICYmIGUubWVzc2FnZSkgfHwgU3RyaW5nKGUpOyB9CiAgICAgICAgICAgIH0KICAgICAgICAg"
    "ICAgc3RhdHMuZG90cyA9IGRvdHM7IHN0YXRzLnBhaW50ZWQgPSBwYWludGVkOyBzdGF0cy5ub0lkID0gbm9JZDsKICAgICAgICAg"
    "ICAgZm9yIChjb25zdCBnIG9mIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoImdbZGF0YS1ibHgtZGV2XSIpKSB7ICAgLy8gZHJv"
    "cCBiYWRnZXMgd2hvc2UgZG90IGlzIGdvbmUKICAgICAgICAgICAgICAgIGNvbnN0IHAgPSBnLnBhcmVudE5vZGU7CiAgICAgICAg"
    "ICAgICAgICBpZiAoIXAgfHwgIVsuLi5wLmNoaWxkcmVuXS5zb21lKGMgPT4gYy5tYXRjaGVzICYmIGMubWF0Y2hlcyhTVEFUVVNf"
    "U0VMKSkpIGcucmVtb3ZlKCk7CiAgICAgICAgICAgIH0KICAgICAgICB9CgogICAgICAgIGxldCB0aW1lciA9IG51bGw7CiAgICAg"
    "ICAgZnVuY3Rpb24gc2NoZWR1bGUoKSB7CiAgICAgICAgICAgIGlmICh0aW1lciB8fCBzdG9wcGVkKSByZXR1cm47CiAgICAgICAg"
    "ICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IHRpbWVyID0gbnVsbDsgdHJ5IHsgc2NhbigpOyB9IGNhdGNoIChlKSB7IGFw"
    "aS5sb2coInNjYW4gZXJyb3I6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOyB9IH0sIDEyMCk7CiAgICAgICAgfQoKICAgICAg"
    "ICBjb25zdCBtbyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKHNjaGVkdWxlKTsKICAgICAgICBtby5vYnNlcnZlKGRvY3VtZW50LmRv"
    "Y3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7CgogICAgICAgIGNvbnN0IHRyaWVzID0g"
    "WzAsIDIwMDAsIDYwMDAsIDE1MDAwLCA0MDAwMF0ubWFwKG1zID0+IHNldFRpbWVvdXQoKCkgPT4geyBmaW5kU3RvcmUoKTsgc2No"
    "ZWR1bGUoKTsgfSwgbXMpKTsKICAgICAgICBjb25zdCByZXBvcnQgPSAoKSA9PiBhcGkubG9nKCJzZWxmLWNoZWNrOiBQcmVzZW5j"
    "ZVN0b3JlICIgKyAocHJlc2VuY2UgPyAiZm91bmQiIDogIk5PVCBmb3VuZCIpICsKICAgICAgICAgICAgIiB8IHN0YXR1cyBkb3Rz"
    "ICIgKyBzdGF0cy5kb3RzICsgIiwgdXNlciBub3QgcmVjb2duaXNlZCAiICsgc3RhdHMubm9JZCArICIsIGljb25zIGRyYXduICIg"
    "KyBzdGF0cy5wYWludGVkICsKICAgICAgICAgICAgIiB8IGRpc3BhdGNoZXIgc3Vic2NyaXB0aW9ucyAiICsgZGlzcGF0Y2hlcnMu"
    "bGVuZ3RoICsKICAgICAgICAgICAgIiB8IGVycm9ycyAiICsgc3RhdHMuZXJyb3JzICsgKHN0YXRzLmxhc3RFcnIgPyAiIChsYXN0"
    "OiAiICsgc3RhdHMubGFzdEVyciArICIpIiA6ICIiKSArCiAgICAgICAgICAgIChwcmVzZW5jZSA/ICIiIDogIiB8IHdpdGhvdXQg"
    "dGhlIHN0b3JlIG5vdGhpbmcgY2FuIGJlIHNob3duIikpOwogICAgICAgIGNvbnN0IHIxID0gc2V0VGltZW91dChyZXBvcnQsIDgw"
    "MDApLCByMiA9IHNldFRpbWVvdXQocmVwb3J0LCAzMDAwMCk7CgogICAgICAgIGFwaS5jbGVhbnVwKCgpID0+IHsKICAgICAgICAg"
    "ICAgc3RvcHBlZCA9IHRydWU7CiAgICAgICAgICAgIG1vLmRpc2Nvbm5lY3QoKTsKICAgICAgICAgICAgdHJpZXMuZm9yRWFjaChj"
    "bGVhclRpbWVvdXQpOyBjbGVhclRpbWVvdXQodGltZXIpOyBjbGVhclRpbWVvdXQocjEpOyBjbGVhclRpbWVvdXQocjIpOwogICAg"
    "ICAgICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJnW2RhdGEtYmx4LWRldl0iKS5mb3JFYWNoKGcgPT4gZy5yZW1vdmUo"
    "KSk7CiAgICAgICAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoInJlY3RbZGF0YS1ibHgtaGlkZV0iKS5mb3JFYWNoKHIg"
    "PT4gci5yZW1vdmVBdHRyaWJ1dGUoImRhdGEtYmx4LWhpZGUiKSk7CiAgICAgICAgfSk7CgogICAgICAgIGZpbmRTdG9yZSgpOwog"
    "ICAgICAgIHNjaGVkdWxlKCk7CiAgICAgICAgYXBpLmxvZygiRGV2aWNlIERldGVjdG9yIHYyLjAuMSBzdGFydGVkIik7CiAgICB9"
    "LAoKICAgIG9wdGlvbnMoYXBpKSB7CiAgICAgICAgcmV0dXJuIFsKICAgICAgICAgICAgYXBpLnVpLnJvdygiQ29sb3VyIHRoZSBp"
    "Y29uIGJ5IHN0YXR1cyAob25saW5lIC8gaWRsZSAvIERuRCkiLAogICAgICAgICAgICAgICAgYXBpLnVpLnRvZ2dsZShhcGkuc2V0"
    "dGluZ3MuZ2V0KCJjb2xvciIsIHRydWUpLCB2ID0+IGFwaS5zZXR0aW5ncy5zZXQoImNvbG9yIiwgdikpKSwKICAgICAgICAgICAg"
    "YXBpLnVpLm5vdGUoIlNob3dzIHRoZSBkZXZpY2UgZWFjaCB1c2VyIGlzIG9ubGluZSBvbiAtIFBDLCBwaG9uZSwgYnJvd3NlciBv"
    "ciBjb25zb2xlIC0gcmVhZCBmcm9tIERpc2NvcmQncyAiICsKICAgICAgICAgICAgICAgICJQcmVzZW5jZVN0b3JlLCB0aGUgc2Ft"
    "ZSBzb3VyY2UgVmVuY29yZCdzIHBsYXRmb3JtIGluZGljYXRvcnMgdXNlLiBJdCBjYW4gb25seSBzaG93IHdoYXQgRGlzY29yZCBz"
    "ZW5kczogIiArCiAgICAgICAgICAgICAgICAiYW55b25lIHdobyBhcHBlYXJzIG9mZmxpbmUsIGluY2x1ZGluZyB1c2VycyBzZXQg"
    "dG8gSW52aXNpYmxlLCByZXBvcnRzIG5vIGRldmljZSwgc28gbm90aGluZyBpcyBkcmF3biBmb3IgIiArCiAgICAgICAgICAgICAg"
    "ICAidGhlbS4gVGhhdCBpcyBhIERpc2NvcmQgc2VydmVyLXNpZGUgcnVsZSBhbmQgaXMgdGhlIHNhbWUgaW4gVmVuY29yZCBhbmQg"
    "ZXZlcnkgb3RoZXIgY2xpZW50IG1vZC4iKQogICAgICAgIF07CiAgICB9Cn0pOwo="
)

# ---- dark palette ----
BG, PANEL, TEXT, MUTED = "#1e1f22", "#2b2d31", "#dbdee1", "#949ba4"
ACCENT, ACCENT_H, OK, ERR = "#5865f2", "#4752c4", "#23a559", "#f23f42"

CREATE_NO_WINDOW = 0x08000000


def _hidden_kw():
    """Make every child process (taskkill, Update.exe) run with no visible window."""
    kw = {}
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        kw["startupinfo"] = si
        kw["creationflags"] = CREATE_NO_WINDOW
    return kw


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_NAME + " updater")
        self.geometry("600x430")
        self.minsize(520, 380)
        self.configure(bg=BG)
        self.q = queue.Queue()
        self.running = False
        self._build_ui()
        self.after(80, self._drain)

    def _build_ui(self):
        head = tk.Frame(self, bg=BG)
        head.pack(fill="x", padx=22, pady=(20, 6))
        tk.Label(head, text=APP_NAME, bg=BG, fg=TEXT, font=("Segoe UI Semibold", 22)).pack(anchor="w")
        tk.Label(head, text="Device Detector v" + PLUGIN_VERSION + "  -  installs & restarts Discord, all hidden",
                 bg=BG, fg=MUTED, font=("Segoe UI", 10)).pack(anchor="w")

        self.btn = tk.Button(self, text="Install / Update", command=self._start,
                             bg=ACCENT, fg="#ffffff", activebackground=ACCENT_H, activeforeground="#ffffff",
                             bd=0, relief="flat", cursor="hand2", font=("Segoe UI Semibold", 12),
                             highlightthickness=0)
        self.btn.pack(fill="x", padx=22, pady=16, ipady=9)
        self.btn.bind("<Enter>", lambda e: self.btn.config(bg=ACCENT_H) if not self.running else None)
        self.btn.bind("<Leave>", lambda e: self.btn.config(bg=ACCENT) if not self.running else None)

        self.log = scrolledtext.ScrolledText(self, bg=PANEL, fg=TEXT, insertbackground=TEXT, bd=0,
                                             font=("Consolas", 9), wrap="word", relief="flat",
                                             padx=10, pady=8, state="disabled")
        self.log.pack(fill="both", expand=True, padx=22, pady=(0, 10))
        self.log.tag_config("ok", foreground=OK)
        self.log.tag_config("err", foreground=ERR)
        self.log.tag_config("muted", foreground=MUTED)

        self.status = tk.Label(self, text="Ready.", bg=BG, fg=MUTED, anchor="w", font=("Segoe UI", 9))
        self.status.pack(fill="x", padx=22, pady=(0, 12))

    # ---------- run everything in a background thread ----------
    def _start(self):
        if self.running:
            return
        self.running = True
        self.btn.config(state="disabled", text="Working...", bg="#3a3d44")
        self._clear()
        self._set_status("Working...")
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            appdata = os.environ.get("APPDATA", "")
            local = os.environ.get("LOCALAPPDATA", "")
            root = os.path.join(appdata, APP_NAME)
            if not os.path.isdir(root):
                self._emit("blxstncord is not installed yet (no %APPDATA%\\blxstncord).", "err")
                self._emit("Run the full blxstncord installer once, then use this to update.", "muted")
                self.q.put(("done", 1)); return

            plugins = os.path.join(root, "plugins")
            os.makedirs(plugins, exist_ok=True)
            dest = os.path.join(plugins, PLUGIN_NAME)
            if os.path.exists(dest) and not os.path.exists(dest + ".bak"):
                try:
                    shutil.copyfile(dest, dest + ".bak")
                    self._emit("backed up previous version -> " + PLUGIN_NAME + ".bak", "muted")
                except Exception:
                    pass
            with open(dest, "wb") as f:
                f.write(base64.b64decode("".join(PLUGIN_B64)))
            self._emit("installed Device Detector " + PLUGIN_VERSION, "ok")
            self._emit("  " + dest, "muted")
            if not os.path.exists(os.path.join(root, "loader.js")):
                self._emit("note: loader.js is missing - run the full installer so the mod actually loads.", "err")

            self._emit("restarting Discord ...")
            try:
                subprocess.run(["taskkill", "/f", "/im", "Discord.exe"], check=False, **_hidden_kw())
            except Exception:
                pass
            time.sleep(2)
            upd = os.path.join(local, "Discord", "Update.exe")
            if os.path.exists(upd):
                subprocess.Popen([upd, "--processStart", "Discord.exe"], **_hidden_kw())
                self._emit("Discord restarted.", "ok")
            else:
                self._emit("Update.exe not found - start Discord yourself.", "err")
            self.q.put(("done", 0))
        except Exception as e:
            self._emit("ERROR: " + str(e), "err")
            self.q.put(("done", -1))

    # ---------- UI plumbing ----------
    def _emit(self, text, tag=None):
        self.q.put(("log", (text, tag)))

    def _drain(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "log":
                    text, tag = payload
                    self._write(text, tag)
                elif kind == "done":
                    self._finish(payload)
        except queue.Empty:
            pass
        self.after(80, self._drain)

    def _finish(self, rc):
        self.running = False
        self.btn.config(state="normal", text="Install / Update", bg=ACCENT)
        self._set_status("Done." if rc == 0 else ("Finished with errors (code %d)." % rc),
                         OK if rc == 0 else ERR)

    def _write(self, text, tag):
        self.log.config(state="normal")
        self.log.insert("end", text + "\n", tag or ())
        self.log.see("end")
        self.log.config(state="disabled")

    def _clear(self):
        self.log.config(state="normal")
        self.log.delete("1.0", "end")
        self.log.config(state="disabled")

    def _set_status(self, text, color=MUTED):
        self.status.config(text=text, fg=color)


if __name__ == "__main__":
    App().mainloop()
