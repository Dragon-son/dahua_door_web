# device_manager.py

import threading
import time
from device_client import DeviceClient


class DeviceManager:

    def __init__(self, idle_timeout=300):
        self.pool = {}
        self.lock = threading.Lock()
        self.idle_timeout = idle_timeout

    def _key(self, d):
        return f"{d['ip']}:{d['port']}"

    def get(self, device):
        key = self._key(device)

        with self.lock:
            if key not in self.pool:
                self.pool[key] = DeviceClient(
                    device['ip'],
                    device['port'],
                    device['username'],
                    device['password']
                )
            return self.pool[key]

    def cleanup(self):
        now = time.time()
        with self.lock:
            for k in list(self.pool.keys()):
                c = self.pool[k]
                if now - c.last_active > self.idle_timeout:
                    c.close()
                    del self.pool[k]