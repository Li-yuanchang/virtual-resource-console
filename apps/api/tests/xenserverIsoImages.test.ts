import assert from "node:assert/strict";
import test from "node:test";
import { buildXenNativeInstallArgs, parseIsoImages, resolveXenProvisionInstallMediaMode, shouldPrepareXenUnattendedIso } from "../src/xenserver.js";

test("groups XenServer ISO library, tools and physical DVD media", () => {
  const output = [
    "ISO\tiso-1\tCentOS-7-x86_64-DVD-1511.iso\t4329570304\tsr-shared\tISO Library\tShared install media\ttrue\tCentOS-7-x86_64-DVD-1511.iso\t4329570304\tiso-library\t\t",
    "ISO\ttools-1\tguest-tools.iso\t71405568\tsr-tools\tXenServer Tools\tXenServer Tools ISOs\ttrue\tguest-tools-7.1.54-1.iso\t71405568\ttools\t\t",
    "ISO\tdvd-1\tSCSI 14:0:0:0\t4329570304\tsr-dvd\tDVD drives\tPhysical DVD drives\tfalse\t/dev/xapi/cd/sr0\t4329570304\thost-dvd\tCentOS 7 x86_64\thost-1",
    "ISO\txc-1\tXenCenter.iso\t54900736\tsr-tools\tXenServer Tools\tXenServer Tools ISOs\ttrue\tXenCenter.iso\t54900736\ttools\t\t",
  ].join("\n");

  const images = parseIsoImages(output);

  assert.deepEqual(
    images.map((image) => ({ id: image.id, name: image.name, sourceType: image.sourceType, hostId: image.hostId })),
    [
      { id: "iso-1", name: "CentOS-7-x86_64-DVD-1511.iso", sourceType: "iso-library", hostId: undefined },
      { id: "dvd-1", name: "CentOS 7 x86_64", sourceType: "host-dvd", hostId: "host-1" },
      { id: "tools-1", name: "guest-tools.iso", sourceType: "tools", hostId: undefined },
    ],
  );
  assert.equal(images[1]?.metadata?.deviceName, "SCSI 14:0:0:0");
  assert.equal(images[1]?.path, "/dev/xapi/cd/sr0");
});

test("omits an empty physical DVD drive", () => {
  const output = "ISO\tdvd-empty\tSCSI 14:0:0:0\t0\tsr-dvd\tDVD drives\tPhysical DVD drives\tfalse\t/dev/xapi/cd/sr0\t0\thost-dvd\t\thost-1";
  assert.deepEqual(parseIsoImages(output), []);
});

test("uses XenServer native HTTP installation for a physical DVD", () => {
  assert.equal(resolveXenProvisionInstallMediaMode("host-dvd", "http-boot-iso"), "native-http");
  assert.equal(resolveXenProvisionInstallMediaMode("host-dvd", "cdrom-http-ks"), "native-http");
  assert.equal(resolveXenProvisionInstallMediaMode("iso-library", "http-boot-iso"), "http-boot-iso");
});

test("passes static network policy to XenServer eliloader", () => {
  assert.equal(
    buildXenNativeInstallArgs({
      ksUrl: "http://192.168.129.1:3988/task/ks.cfg",
      ip: "192.168.129.21",
      gateway: "192.168.129.254",
      netmask: "255.255.255.0",
    }),
    "inst.ks=http://192.168.129.1:3988/task/ks.cfg inst.text rd.neednet=1 net.ifnames=0 biosdevname=0 ip=192.168.129.21::192.168.129.254:255.255.255.0:vrc:eth0:none bootdev=eth0 ksdevice=eth0",
  );
});

test("does not generate an ISO for XenServer native HTTP installation", () => {
  assert.equal(shouldPrepareXenUnattendedIso("native-http"), false);
  assert.equal(shouldPrepareXenUnattendedIso("cdrom-http-ks"), false);
  assert.equal(shouldPrepareXenUnattendedIso("http-boot-iso"), true);
  assert.equal(shouldPrepareXenUnattendedIso("offline-iso"), true);
});
