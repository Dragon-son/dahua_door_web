# device_client.py

import datetime
import time
import base64
import io
import threading
import requests
import concurrent.futures
from PIL import Image
from requests.auth import HTTPDigestAuth

# 新增导入：用于时区转换
from datetime import timezone, timedelta

from NetSDK.NetSDK import NetClient
from NetSDK.SDK_Callback import fDisConnect, fHaveReConnect, fRealDataCallBackEx2
from NetSDK.SDK_Struct import *
from NetSDK.SDK_Enum import *
from ctypes import sizeof, cast, POINTER, pointer, byref, c_void_p, c_ubyte

METHOD_MAP = {
    1: "刷卡", 2: "密码", 3: "卡+密码", 4: "指纹",
    5: "远程开门", 6: "按钮开门", 16: "人脸识别",
}


def make_net_time(dt):
    t = NET_TIME()
    t.dwYear = dt.year
    t.dwMonth = dt.month
    t.dwDay = dt.day
    t.dwHour = dt.hour
    t.dwMinute = dt.minute
    t.dwSecond = dt.second
    return t


def compress_image(path, max_kb=0, width=0, height=0, quality=0):
    img = Image.open(path).convert("RGB")
    if width > 0 and height > 0:
        img = img.resize((width, height))
    elif width > 0 or height > 0:
        img.thumbnail((width or 9999, height or 9999))
    q = quality if quality > 0 else 85
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=q)
    data = buf.getvalue()
    if max_kb and len(data) > max_kb * 1024:
        return data[:max_kb * 1024]
    return data


class DeviceClient:

    def __init__(self, ip, port, username, password):
        self.ip = ip
        self.port = port
        self.username = username
        self.password = password
        
        self._play_id = None
        self._m_RealDataCallBack = None
        self._preview_callback = None      # 外部注册的数据回调 fn(bytes)
        self._preview_lock = threading.Lock()

        self.sdk = NetClient()
        self.loginID = 0
        self.lock = threading.Lock()
        self.last_active = time.time()

        self._init()
        self._login()

    def _init(self):
        self.sdk.InitEx(fDisConnect(lambda *a: print(f"断线 {self.ip}")))
        self.sdk.SetAutoReconnect(fHaveReConnect(lambda *a: print(f"重连 {self.ip}")))

    def _login(self):
        stuIn = NET_IN_LOGIN_WITH_HIGHLEVEL_SECURITY()
        stuIn.dwSize = sizeof(stuIn)
        stuIn.szIP = self.ip.encode()
        stuIn.nPort = self.port
        stuIn.szUserName = self.username.encode()
        stuIn.szPassword = self.password.encode()
        stuIn.emSpecCap = EM_LOGIN_SPAC_CAP_TYPE.TCP

        stuOut = NET_OUT_LOGIN_WITH_HIGHLEVEL_SECURITY()
        stuOut.dwSize = sizeof(stuOut)

        loginID, _, err = self.sdk.LoginWithHighLevelSecurity(stuIn, stuOut)
        if loginID == 0:
            raise Exception(f"登录失败: {err}")

        self.loginID = loginID

    def ensure(self):
        if self.loginID == 0:
            self._login()

    # ================= 开门 =================
    def open_door(self, channel=0):
        with self.lock:
            self.ensure()
            ctrl = NET_CTRL_ACCESS_OPEN()
            ctrl.dwSize = sizeof(ctrl)
            ctrl.nChannelID = channel
            ok = self.sdk.ControlDevice(self.loginID, CtrlType.ACCESS_OPEN, ctrl, 5000)
            self.last_active = time.time()
            if not ok:
                raise Exception(self.sdk.GetLastErrorMessage())
            return True

    # ================= 视频预览 =================
    def start_preview(self, data_callback, channel=0):
        """
        开启实时预览，原始 dhav 数据通过 data_callback(bytes) 回调。
        data_callback 会在 SDK 回调线程中被调用，请勿在其中做耗时操作。
        """
        with self._preview_lock:
            if self._play_id is not None:
                raise Exception("预览已在进行中")

            self.ensure()
            self._preview_callback = data_callback

            def _raw_cb(lRealHandle, dwDataType, pBuffer, dwBufSize, param, dwUser):
                # dwDataType == 0 : 原始码流数据
                if dwDataType == 0 and dwBufSize > 0:
                    cb = self._preview_callback
                    if cb:
                        try:
                            data = bytes(cast(pBuffer, POINTER(c_ubyte * dwBufSize)).contents)
                            cb(data)
                        except Exception as e:
                            print(f"[preview] 回调异常: {e}")
                return 0

            self._m_RealDataCallBack = fRealDataCallBackEx2(_raw_cb)

            # RealPlayEx: 0 = 主码流
            play_id = self.sdk.RealPlayEx(self.loginID, channel, 0, SDK_RealPlayType.Realplay)
            if not play_id:
                self._preview_callback = None
                self._m_RealDataCallBack = None
                raise Exception(f"RealPlayEx 失败: {self.sdk.GetLastErrorMessage()}")

            # 注册原始码流回调（RAW_DATA = 4）
            if not self.sdk.SetRealDataCallBackEx2(
                play_id,
                self._m_RealDataCallBack,
                None,
                EM_REALDATA_FLAG.RAW_DATA
            ):
                self.sdk.StopRealPlayEx(play_id)
                self._preview_callback = None
                self._m_RealDataCallBack = None
                raise Exception(f"SetRealDataCallBackEx2 失败: {self.sdk.GetLastErrorMessage()}")

            self._play_id = play_id
            self.last_active = time.time()
            print(f"[preview] 开启预览成功 {self.ip} play_id={play_id}")

    def stop_preview(self):
        """停止实时预览"""
        with self._preview_lock:
            if self._play_id is None:
                return
            try:
                self.sdk.StopRealPlayEx(self._play_id)
                print(f"[preview] 停止预览 {self.ip} play_id={self._play_id}")
            except Exception as e:
                print(f"[preview] StopRealPlayEx 异常: {e}")
            finally:
                self._play_id = None
                self._preview_callback = None
                self._m_RealDataCallBack = None

    def is_previewing(self):
        with self._preview_lock:
            return self._play_id is not None
    # ================= 人员管理 =================
    def _parse_date(self, value):
        if isinstance(value, datetime.datetime):
            return value
        if isinstance(value, datetime.date):
            return datetime.datetime.combine(value, datetime.time.min)
        if isinstance(value, str):
            try:
                return datetime.datetime.strptime(value, "%Y-%m-%d")
            except ValueError as exc:
                raise ValueError(f"日期格式错误: {value}，应为 YYYY-MM-DD") from exc
        raise ValueError(f"不支持的日期类型: {type(value).__name__}")

    def _build_access_user_info(self, user_id, name, status=0, doors=None, valid_begin=None, valid_end=None):
        user = NET_ACCESS_USER_INFO()
        user.szUserID = user_id.encode()
        user.szName = name.encode("utf-8")
        user.nUserStatus = int(status)

        door_list = list(doors) if doors else [0]
        user.nDoorNum = len(door_list)
        for idx, door in enumerate(door_list):
            user.nDoors[idx] = int(door)

        begin_dt = self._parse_date(valid_begin or "2000-01-01")
        end_dt = self._parse_date(valid_end or "2037-12-31")
        user.stuValidBeginTime = make_net_time(begin_dt)
        user.stuValidEndTime = make_net_time(end_dt)
        return user

    def update_user(self, user_id, name, status=0, doors=None, valid_begin=None, valid_end=None):
        with self.lock:
            self.ensure()
            user = self._build_access_user_info(
                user_id=user_id,
                name=name,
                status=status,
                doors=doors,
                valid_begin=valid_begin,
                valid_end=valid_end,
            )

            fail_codes = (C_ENUM * 1)()
            inParam = NET_IN_ACCESS_USER_SERVICE_INSERT()
            inParam.dwSize = sizeof(inParam)
            inParam.nInfoNum = 1
            inParam.pUserInfo = pointer(user)
            outParam = NET_OUT_ACCESS_USER_SERVICE_INSERT()
            outParam.dwSize = sizeof(outParam)
            outParam.nMaxRetNum = 1
            outParam.pFailCode = cast(fail_codes, POINTER(C_ENUM))

            ok = self.sdk.OperateAccessUserService(
                self.loginID,
                EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_INSERT,
                inParam, outParam, 5000
            )
            self.last_active = time.time()
            if not ok:
                raise Exception(self.sdk.GetLastErrorMessage())
            return True

    def add_user(self, user_id, name):
        return self.update_user(
            user_id=user_id,
            name=name,
            status=0,
            doors=[0],
            valid_begin="2000-01-01",
            valid_end="2037-12-31",
        )

    def _require_existing_user(self, user_id):
        user = self.get_user_by_id(user_id)
        if not user:
            raise Exception("用户不存在")
        return user

    def freeze_user(self, user_id):
        user = self._require_existing_user(user_id)
        return self.update_user(
            user_id=user_id,
            name=user["name"],
            status=1,
            doors=user["doors"],
            valid_begin=user["valid_begin"],
            valid_end=user["valid_end"],
        )

    def unfreeze_user(self, user_id):
        user = self._require_existing_user(user_id)
        return self.update_user(
            user_id=user_id,
            name=user["name"],
            status=0,
            doors=user["doors"],
            valid_begin=user["valid_begin"],
            valid_end=user["valid_end"],
        )

    def update_user_validity(self, user_id, valid_begin, valid_end):
        user = self._require_existing_user(user_id)
        return self.update_user(
            user_id=user_id,
            name=user["name"],
            status=user["status"],
            doors=user["doors"],
            valid_begin=valid_begin,
            valid_end=valid_end,
        )

    def _get_user_by_id_nolock(self, user_id):
        """内部使用：不加锁的单用户查询（调用前必须已持有锁或确保单线程）"""
        self.ensure()
        fail_codes = (C_ENUM * 1)()
        users = (NET_ACCESS_USER_INFO * 1)()
        inParam = NET_IN_ACCESS_USER_SERVICE_GET()
        inParam.dwSize = sizeof(inParam)
        inParam.nUserNum = 1
        inParam.szUserID = user_id.encode().ljust(32, b'\x00')
        outParam = NET_OUT_ACCESS_USER_SERVICE_GET()
        outParam.dwSize = sizeof(outParam)
        outParam.nMaxRetNum = 1
        outParam.pUserInfo = cast(users, POINTER(NET_ACCESS_USER_INFO))
        outParam.pFailCode = cast(fail_codes, POINTER(C_ENUM))

        ok = self.sdk.OperateAccessUserService(
            self.loginID,
            EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_GET,
            inParam, outParam, 5000
        )
        self.last_active = time.time()
        if not ok:
            return None
        u = users[0]
        name = u.szName.decode('utf-8', errors='ignore').strip('\x00')
        begin = u.stuValidBeginTime
        end = u.stuValidEndTime
        return {
            "user_id": user_id,
            "name": name,
            "status": u.nUserStatus,
            "doors": [u.nDoors[i] for i in range(u.nDoorNum)],
            "valid_begin": f"{begin.dwYear}-{begin.dwMonth:02d}-{begin.dwDay:02d}",
            "valid_end": f"{end.dwYear}-{end.dwMonth:02d}-{end.dwDay:02d}",
        }

    def get_user_by_id(self, user_id):
        """按用户ID精确查询设备人员（线程安全）"""
        with self.lock:
            return self._get_user_by_id_nolock(user_id)

    def delete_user(self, user_id):
        with self.lock:
            self.ensure()
            fail_codes = (C_ENUM * 1)()
            inParam = NET_IN_ACCESS_USER_SERVICE_REMOVE()
            inParam.dwSize = sizeof(inParam)
            inParam.nUserNum = 1
            inParam.szUserID = user_id.encode().ljust(32, b'\x00')
            outParam = NET_OUT_ACCESS_USER_SERVICE_REMOVE()
            outParam.dwSize = sizeof(outParam)
            outParam.nMaxRetNum = 1
            outParam.pFailCode = cast(fail_codes, POINTER(C_ENUM))

            ok = self.sdk.OperateAccessUserService(
                self.loginID,
                EM_A_NET_EM_ACCESS_CTL_USER_SERVICE.NET_EM_ACCESS_CTL_USER_SERVICE_REMOVE,
                inParam, outParam, 5000
            )
            self.last_active = time.time()
            if not ok:
                raise Exception(self.sdk.GetLastErrorMessage())
            return True

    # ---------- 分页获取全部用户（修复死锁）----------
    def get_users_paginated(self, offset=0, limit=20):
        """分页获取设备人员（稳定版，避免死锁）"""
        def _do_query():
            with self.lock:
                self.ensure()
                print("[get_users_paginated] 开始获取用户ID列表...")
                
                # 第一步：获取所有门禁卡记录中的 UserID
                condition = NET_A_FIND_RECORD_ACCESSCTLCARD_CONDITION()
                condition.dwSize = sizeof(condition)
                condition.abCardNo = False
                condition.abUserID = False
                condition.abIsValid = False

                inParam = NET_IN_FIND_RECORD_PARAM()
                inParam.dwSize = sizeof(inParam)
                inParam.emType = EM_NET_RECORD_TYPE.ACCESSCTLCARD
                inParam.pQueryCondition = cast(byref(condition), c_void_p)

                outParam = NET_OUT_FIND_RECORD_PARAM()
                outParam.dwSize = sizeof(outParam)

                print("[get_users_paginated] 调用 FindRecord...")
                result = self.sdk.FindRecord(self.loginID, inParam, outParam, 5000)
                if not result:
                    raise Exception(f"FindRecord失败: {self.sdk.GetLastErrorMessage()}")
                print("[get_users_paginated] FindRecord 成功")

                findHandle = outParam.lFindeHandle
                all_user_ids = []
                BATCH = 50

                while True:
                    findIn = NET_IN_FIND_NEXT_RECORD_PARAM()
                    findIn.dwSize = sizeof(findIn)
                    findIn.lFindeHandle = findHandle
                    findIn.nFileCount = BATCH

                    records = (NET_RECORDSET_ACCESS_CTL_CARD * BATCH)()
                    for rec in records:
                        rec.dwSize = sizeof(rec)

                    findOut = NET_OUT_FIND_NEXT_RECORD_PARAM()
                    findOut.dwSize = sizeof(findOut)
                    findOut.pRecordList = cast(records, c_void_p)
                    findOut.nMaxRecordNum = BATCH

                    ret = self.sdk.FindNextRecord(findIn, findOut, 5000)
                    got = findOut.nRetRecordNum
                    if not ret or got == 0:
                        break

                    for i in range(got):
                        uid = records[i].szUserID.decode('utf-8', errors='ignore').strip('\x00')
                        if uid and uid not in all_user_ids:
                            all_user_ids.append(uid)

                self.sdk.FindRecordClose(findHandle)
                total = len(all_user_ids)
                print(f"[get_users_paginated] 共找到 {total} 个 UserID")

                # 第二步：截取当前页的ID，并直接调用内部不加锁版查询
                page_ids = all_user_ids[offset:offset+limit]
                users = []
                for idx, uid in enumerate(page_ids):
                    print(f"[get_users_paginated] 查询第 {idx+1}/{len(page_ids)} 个用户: {uid}")
                    info = self._get_user_by_id_nolock(uid)
                    if info:
                        info["hasFace"] = False
                        users.append(info)
                return total, users

        # 整体超时控制：最长等待 60 秒
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(_do_query)
                return future.result(timeout=60)
        except concurrent.futures.TimeoutError:
            print("[get_users_paginated] 整体操作超时（60秒）")
            raise Exception("查询设备人员超时，请稍后重试")

    # ---------- 按姓名模糊搜索 ----------
    def search_users_by_name(self, keyword):
        """按姓名模糊搜索设备人员"""
        with self.lock:
            self.ensure()
            # 第一步：获取所有门禁卡记录中的 UserID
            condition = NET_A_FIND_RECORD_ACCESSCTLCARD_CONDITION()
            condition.dwSize = sizeof(condition)
            condition.abCardNo = False
            condition.abUserID = False
            condition.abIsValid = False

            inParam = NET_IN_FIND_RECORD_PARAM()
            inParam.dwSize = sizeof(inParam)
            inParam.emType = EM_NET_RECORD_TYPE.ACCESSCTLCARD
            inParam.pQueryCondition = cast(byref(condition), c_void_p)

            outParam = NET_OUT_FIND_RECORD_PARAM()
            outParam.dwSize = sizeof(outParam)

            result = self.sdk.FindRecord(self.loginID, inParam, outParam, 5000)
            if not result:
                raise Exception(f"获取用户ID列表失败: {self.sdk.GetLastErrorMessage()}")

            findHandle = outParam.lFindeHandle
            all_user_ids = []
            BATCH = 50

            while True:
                findIn = NET_IN_FIND_NEXT_RECORD_PARAM()
                findIn.dwSize = sizeof(findIn)
                findIn.lFindeHandle = findHandle
                findIn.nFileCount = BATCH

                records = (NET_RECORDSET_ACCESS_CTL_CARD * BATCH)()
                for rec in records:
                    rec.dwSize = sizeof(rec)

                findOut = NET_OUT_FIND_NEXT_RECORD_PARAM()
                findOut.dwSize = sizeof(findOut)
                findOut.pRecordList = cast(records, c_void_p)
                findOut.nMaxRecordNum = BATCH

                ret = self.sdk.FindNextRecord(findIn, findOut, 5000)
                got = findOut.nRetRecordNum
                if not ret or got == 0:
                    break

                for i in range(got):
                    uid = records[i].szUserID.decode('utf-8', errors='ignore').strip('\x00')
                    if uid and uid not in all_user_ids:
                        all_user_ids.append(uid)

            self.sdk.FindRecordClose(findHandle)

            # 第二步：逐个查询用户详情，按姓名过滤（调用内部不加锁版）
            matched = []
            for uid in all_user_ids:
                info = self._get_user_by_id_nolock(uid)
                if info and keyword in info["name"]:
                    matched.append(info)
            return matched

    # ================= 人脸 =================
    def add_face(self, user_id, path):
        img = compress_image(path)
        b64 = base64.b64encode(img).decode()
        url = f"http://{self.ip}/cgi-bin/FaceInfoManager.cgi?action=add"
        r = requests.post(
            url,
            json={"UserID": user_id, "Info": {"PhotoData": [b64]}},
            auth=HTTPDigestAuth(self.username, self.password),
            timeout=30
        )
        if r.status_code != 200:
            raise Exception(r.text)
        return True

    def delete_face(self, user_id):
        url = f"http://{self.ip}/cgi-bin/FaceInfoManager.cgi?action=delete"
        r = requests.post(
            url,
            json={"UserIDList": [user_id]},
            auth=HTTPDigestAuth(self.username, self.password),
            timeout=30
        )
        if r.status_code != 200:
            raise Exception(r.text)
        return True

    # ================= 门状态（CGI） =================
    def get_door_status(self, channel=1):
        """查询门状态，返回 'Open' / 'Close'，失败返回 None"""
        urls = [
            f"http://{self.ip}/cgi-bin/accessControl.cgi?action=getLockStatus&channel={channel}",
            f"http://{self.ip}/cgi-bin/accessControl.cgi?action=getDoorStatus&channel={channel}"
        ]
        for url in urls:
            try:
                r = requests.get(url, auth=HTTPDigestAuth(self.username, self.password), timeout=10)
                if r.status_code == 200:
                    text = r.text.strip()
                    if 'status=' in text:
                        return text.split('status=')[-1].split('\n')[0].strip()
                    elif 'Info.status=' in text:
                        return text.split('Info.status=')[-1].split('\n')[0].strip()
            except Exception:
                continue
        return None

    # ================= 日志（已加时区转换） =================
    def query_log(self, start, end):
        with self.lock:
            self.ensure()
            records = []

            cond = NET_FIND_RECORD_ACCESSCTLCARDREC_CONDITION_EX()
            cond.dwSize = sizeof(cond)
            cond.bTimeEnable = True
            cond.stStartTime = make_net_time(start)
            cond.stEndTime = make_net_time(end)

            inParam = NET_IN_FIND_RECORD_PARAM()
            inParam.dwSize = sizeof(inParam)
            inParam.emType = EM_NET_RECORD_TYPE.ACCESSCTLCARDREC_EX
            inParam.pQueryCondition = cast(byref(cond), c_void_p)

            outParam = NET_OUT_FIND_RECORD_PARAM()
            outParam.dwSize = sizeof(outParam)

            if not self.sdk.FindRecord(self.loginID, inParam, outParam, 5000):
                raise Exception(self.sdk.GetLastErrorMessage())

            handle = outParam.lFindeHandle

            while True:
                findIn = NET_IN_FIND_NEXT_RECORD_PARAM()
                findIn.dwSize = sizeof(findIn)
                findIn.lFindeHandle = handle
                findIn.nFileCount = 20

                recs = (NET_RECORDSET_ACCESS_CTL_CARDREC * 20)()
                for r in recs:
                    r.dwSize = sizeof(r)

                findOut = NET_OUT_FIND_NEXT_RECORD_PARAM()
                findOut.dwSize = sizeof(findOut)
                findOut.pRecordList = cast(recs, c_void_p)
                findOut.nMaxRecordNum = 20

                if not self.sdk.FindNextRecord(findIn, findOut, 5000):
                    break

                if findOut.nRetRecordNum == 0:
                    break

                for i in range(findOut.nRetRecordNum):
                    rec = recs[i]
                    t = rec.stuTime

                    # UTC -> 东八区
                    utc_time = datetime.datetime(
                        t.dwYear, t.dwMonth, t.dwDay,
                        t.dwHour, t.dwMinute, t.dwSecond,
                        tzinfo=timezone.utc
                    )
                    local_tz = timezone(timedelta(hours=8))
                    local_time = utc_time.astimezone(local_tz)

                    records.append({
                        "time": local_time.strftime("%Y-%m-%d %H:%M:%S"),
                        "door": rec.nDoor,
                        "user_id": rec.szUserID.decode(errors="ignore"),
                        "name": rec.szCardName.decode(errors="ignore"),
                        "status": "成功" if rec.bStatus else "失败",
                        "method": METHOD_MAP.get(rec.emMethod, str(rec.emMethod))
                    })

            self.sdk.FindRecordClose(handle)
            return records

    def close(self):
        self.stop_preview()
        with self.lock:
            if self.loginID:
                self.sdk.Logout(self.loginID)
                self.loginID = 0
            self.sdk.Cleanup()