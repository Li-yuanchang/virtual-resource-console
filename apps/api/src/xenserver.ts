import { Client } from "ssh2";
import { assessVmReclaim } from "./analysis/reclaimStateMachine.js";
import type { ProvisionProgressReporter, VirtualizationProvider } from "./providers/provider.js";
import { buildXenServerPolicyEnv, getRuntimePolicy, inferIpv4FromName } from "./runtimePolicy.js";
import { normalizeStorageCapacity } from "./storageCapacity.js";
import { describeStorageRepository } from "./storageRepositoryProfile.js";
import type {
  HostNode,
  IsoImage,
  HostSummary,
  MetricQuery,
  MetricSample,
  NetworkInterface,
  PagedResult,
  ProviderScope,
  ResourcePool,
  StorageRepository,
  VirtualDisk,
  VmActionOptions,
  VmActionResult,
  VmDisk,
  VmInventorySummary,
  VmMetricSnapshot,
  VmNode,
  VmProvisionPlanItem,
  VmPowerAction,
  VmProvisionCreatedVm,
  VmProvisionRequest,
  VmProvisionResult,
  VmQuery,
  VmRenameResult,
  VmResizeExecutionRequest,
  VmResizeResult,
  VmSearchIndexItem,
  VmSnapshot,
  XenConnectionInput,
  XenOverview,
} from "./types.js";
import { assertVmRenameCurrentName, normalizeVmRenameInput, VmRenameConflictError } from "./vmRename.js";
import {
  cleanupRegisteredXenGeneratedIso,
  prepareXenCentosUnattendedIso,
  prepareXenWindowsUnattendIso,
  resolveXenInstallMediaMode,
} from "./xenserverUnattendedIso.js";
import type { XenInstallMediaMode } from "./xenserverUnattendedIso.js";
import { normalizeGuestOsLabel } from "./guestOs.js";
import { isXenGuestToolsIsoName } from "./installMediaPolicy.js";
import { prepareXenInstallMedia } from "./xenserverProvisionStrategies.js";

const HOST_INVENTORY_SCRIPT = String.raw`
bytes_to_gib() {
  awk -v b="$1" 'BEGIN { if (b == "" || b == "<not in database>" || b == "0") printf "0"; else printf "%.1f", b/1024/1024/1024 }'
}
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
num_or_zero() {
  if [ -z "$1" ] || [ "$1" = "<not in database>" ]; then
    printf "0"
  else
    printf "%s" "$1"
  fi
}
extract_cpu_field() {
  key="$1"
  printf "%s" "$2" | sed -n "s/.*$key[^0-9]*\([0-9][0-9]*\).*/\1/p"
}
extract_cpu_model() {
  printf "%s" "$1" | sed -n 's/.*modelname[^:]*: \([^;]*\).*/\1/p'
}
host_list="$(xe host-list --minimal 2>/dev/null | tr ',' ' ')"
for host in $host_list; do
  host_name="$(xe host-param-get uuid="$host" param-name=name-label 2>/dev/null | clean_one_line)"
  host_address="$(xe host-param-get uuid="$host" param-name=address 2>/dev/null | clean_one_line)"
  host_enabled="$(xe host-param-get uuid="$host" param-name=enabled 2>/dev/null | clean_one_line)"
  host_mem_total="$(xe host-param-get uuid="$host" param-name=memory-total 2>/dev/null | clean_one_line)"
  host_mem_free="$(xe host-param-get uuid="$host" param-name=memory-free 2>/dev/null | clean_one_line)"
  host_cpu_info="$(xe host-param-get uuid="$host" param-name=cpu_info 2>/dev/null | clean_one_line)"
  host_version="$(xe host-param-get uuid="$host" param-name=software-version 2>/dev/null | clean_one_line)"
  cpu_count="$(extract_cpu_field "cpu_count" "$host_cpu_info")"
  socket_count="$(extract_cpu_field "socket_count" "$host_cpu_info")"
  cpu_model="$(extract_cpu_model "$host_cpu_info")"
  if [ -z "$cpu_count" ] || [ "$cpu_count" = "0" ]; then
    cpu_count="$(xe host-cpu-list host-uuid="$host" --minimal 2>/dev/null | tr ',' ' ' | wc -w | awk '{print $1}')"
  fi
  if [ -z "$socket_count" ] || [ "$socket_count" = "0" ]; then
    socket_count="$(extract_cpu_field "sockets" "$host_cpu_info")"
  fi
  if [ -z "$cpu_model" ]; then
    first_cpu="$(xe host-cpu-list host-uuid="$host" --minimal 2>/dev/null | tr ',' ' ' | awk '{print $1}')"
    if [ -n "$first_cpu" ]; then
      cpu_model="$(xe host-cpu-param-get uuid="$first_cpu" param-name=modelname 2>/dev/null | clean_one_line)"
    fi
  fi
  product_version="$(printf "%s" "$host_version" | sed -n 's/.*product_version_text: \([^;]*\).*/\1/p')"
  uptime_text="$(uptime | clean_one_line)"
  printf 'HOST\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$host" "$host_name" "$host_address" "$host_enabled" "$product_version" "$cpu_model" "$(num_or_zero "$cpu_count")" "$(num_or_zero "$socket_count")" "$(bytes_to_gib "$host_mem_total")" "$(bytes_to_gib "$host_mem_free")" "$uptime_text"

  for pif in $(xe pif-list host-uuid="$host" --minimal 2>/dev/null | tr ',' ' '); do
    device="$(xe pif-param-get uuid="$pif" param-name=device 2>/dev/null | clean_one_line)"
    mac="$(xe pif-param-get uuid="$pif" param-name=MAC 2>/dev/null | clean_one_line)"
    ip="$(xe pif-param-get uuid="$pif" param-name=IP 2>/dev/null | clean_one_line)"
    netmask="$(xe pif-param-get uuid="$pif" param-name=netmask 2>/dev/null | clean_one_line)"
    gateway="$(xe pif-param-get uuid="$pif" param-name=gateway 2>/dev/null | clean_one_line)"
    management="$(xe pif-param-get uuid="$pif" param-name=management 2>/dev/null | clean_one_line)"
    attached="$(xe pif-param-get uuid="$pif" param-name=currently-attached 2>/dev/null | clean_one_line)"
    network="$(xe pif-param-get uuid="$pif" param-name=network-name-label 2>/dev/null | clean_one_line)"
    printf 'PIF\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$host" "$device" "$mac" "$ip" "$netmask" "$gateway" "$management" "$attached" "$network"
  done
done

for sr in $(xe sr-list --minimal 2>/dev/null | tr ',' ' '); do
  name="$(xe sr-param-get uuid="$sr" param-name=name-label 2>/dev/null | clean_one_line)"
  type="$(xe sr-param-get uuid="$sr" param-name=type 2>/dev/null | clean_one_line)"
  physical="$(xe sr-param-get uuid="$sr" param-name=physical-size 2>/dev/null | clean_one_line)"
  used="$(xe sr-param-get uuid="$sr" param-name=physical-utilisation 2>/dev/null | clean_one_line)"
  virtual="$(xe sr-param-get uuid="$sr" param-name=virtual-allocation 2>/dev/null | clean_one_line)"
  shared="$(xe sr-param-get uuid="$sr" param-name=shared 2>/dev/null | clean_one_line)"
  printf 'SR\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$type" "$(bytes_to_gib "$physical")" "$(bytes_to_gib "$used")" "$(bytes_to_gib "$virtual")" "$shared"
done
`;

const VM_SUMMARY_SCRIPT = String.raw`
bytes_to_gib() {
  awk -v b="$1" 'BEGIN { if (b == "" || b == "<not in database>" || b == "0") printf "0"; else printf "%.1f", b/1024/1024/1024 }'
}
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
num_or_zero() {
  if [ -z "$1" ] || [ "$1" = "<not in database>" ]; then
    printf "0"
  else
    printf "%s" "$1"
  fi
}
host_count="$(xe host-list --minimal 2>/dev/null | tr ',' ' ' | wc -w | awk '{print $1}')"
total="0"
running="0"
halted="0"
vcpu_total="0"
memory_gib_total="0"
running_vcpu_total="0"
running_memory_gib_total="0"
vm_list="$(xe vm-list is-control-domain=false --minimal 2>/dev/null | tr ',' ' ')"
for vm in $vm_list; do
  resident="$(xe vm-param-get uuid="$vm" param-name=resident-on 2>/dev/null | clean_one_line)"
  power="$(xe vm-param-get uuid="$vm" param-name=power-state 2>/dev/null | clean_one_line)"
  affinity="$(xe vm-param-get uuid="$vm" param-name=affinity 2>/dev/null | clean_one_line)"
  include_vm="true"
  if [ -n "$VRC_HOST_ID" ]; then
    include_vm="false"
    if [ "$resident" = "$VRC_HOST_ID" ]; then
      include_vm="true"
    elif [ "$power" = "halted" ] && [ "$affinity" = "$VRC_HOST_ID" ]; then
      include_vm="true"
    elif [ "$power" = "halted" ] && [ "$host_count" = "1" ] && { [ -z "$affinity" ] || [ "$affinity" = "<not in database>" ]; }; then
      include_vm="true"
    fi
  fi
  if [ "$include_vm" != "true" ]; then
    continue
  fi
  vcpu_max="$(xe vm-param-get uuid="$vm" param-name=VCPUs-max 2>/dev/null | clean_one_line)"
  vcpu_start="$(xe vm-param-get uuid="$vm" param-name=VCPUs-at-startup 2>/dev/null | clean_one_line)"
  vcpu_live="$(xe vm-param-get uuid="$vm" param-name=VCPUs-number 2>/dev/null | clean_one_line)"
  vcpu_count="$vcpu_max"
  if [ -z "$vcpu_count" ] || [ "$vcpu_count" = "0" ] || [ "$vcpu_count" = "<not in database>" ]; then
    vcpu_count="$vcpu_start"
  fi
  if [ -z "$vcpu_count" ] || [ "$vcpu_count" = "0" ] || [ "$vcpu_count" = "<not in database>" ]; then
    vcpu_count="$vcpu_live"
  fi
  mem_dyn_max="$(xe vm-param-get uuid="$vm" param-name=memory-dynamic-max 2>/dev/null | clean_one_line)"
  mem_gib="$(bytes_to_gib "$mem_dyn_max")"
  total=$((total+1))
  if [ "$power" = "running" ]; then
    running=$((running+1))
    running_vcpu_total="$(awk -v a="$running_vcpu_total" -v b="$(num_or_zero "$vcpu_count")" 'BEGIN { printf "%.0f", a + b }')"
    running_memory_gib_total="$(awk -v a="$running_memory_gib_total" -v b="$mem_gib" 'BEGIN { printf "%.1f", a + b }')"
  elif [ "$power" = "halted" ]; then
    halted=$((halted+1))
  fi
  vcpu_total="$(awk -v a="$vcpu_total" -v b="$(num_or_zero "$vcpu_count")" 'BEGIN { printf "%.0f", a + b }')"
  memory_gib_total="$(awk -v a="$memory_gib_total" -v b="$mem_gib" 'BEGIN { printf "%.1f", a + b }')"
done
printf 'SUMMARY\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$total" "$running" "$halted" "$vcpu_total" "$memory_gib_total" "$running_vcpu_total" "$running_memory_gib_total"
`;

const VM_SEARCH_INDEX_SCRIPT = String.raw`
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
is_managed_ip() {
  if [ -z "$VRC_MANAGED_IP_PATTERN" ]; then return 0; fi
  printf "%s" "$1" | grep -Eq "$VRC_MANAGED_IP_PATTERN"
}
first_ip() {
  grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | while read -r candidate; do
    if is_managed_ip "$candidate"; then printf "%s" "$candidate"; break; fi
  done
}
valid_host_octet() {
  awk -v n="$1" 'BEGIN { exit !(n ~ /^[0-9]+$/ && n > 0 && n < 255) }'
}
infer_ip_from_name() {
  name="$1"
  ip="$(printf "%s" "$name" | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)"
  if [ -n "$ip" ]; then
    last="$(printf "%s" "$ip" | awk -F. '{print $NF}')"
    if valid_host_octet "$last" && is_managed_ip "$ip"; then printf "%s" "$ip"; return; fi
  fi
  short="$(printf "%s" "$name" | grep -Eo '(^|[^0-9])[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)' | head -1 | grep -Eo '[0-9]{1,3}\.[0-9]{1,3}' | head -1)"
  if [ -n "$short" ]; then
    subnet="$(printf "%s" "$short" | awk -F. '{print $1}')"
    last="$(printf "%s" "$short" | awk -F. '{print $2}')"
    if valid_host_octet "$last"; then
      for prefix in $VRC_SHORT_IP_PREFIXES; do
        prefix_subnet="$(printf "%s" "$prefix" | awk -F. '{print $3}')"
        if [ "$subnet" = "$prefix_subnet" ]; then
          candidate="$prefix.$last"
          if is_managed_ip "$candidate"; then printf "%s" "$candidate"; return; fi
        fi
      done
      for allowed in $VRC_SHORT_IP_THIRD_OCTETS; do
        if [ "$subnet" != "$allowed" ] || [ -z "$VRC_SHORT_IP_BASE_PREFIX" ]; then
          continue
        fi
        candidate="$VRC_SHORT_IP_BASE_PREFIX.$subnet.$last"
        if is_managed_ip "$candidate"; then printf "%s" "$candidate"; return; fi
      done
    fi
  fi
  host_only="$(printf "%s" "$name" | grep -Eo '^[0-9]{1,3}([^0-9.]|$)' | head -1 | grep -Eo '[0-9]{1,3}' | head -1)"
  if [ -n "$host_only" ] && [ -n "$VRC_HOST_ONLY_PREFIX" ] && valid_host_octet "$host_only"; then
    candidate="$VRC_HOST_ONLY_PREFIX.$host_only"
    if is_managed_ip "$candidate"; then printf "%s" "$candidate"; fi
  fi
}
first_search_ip() {
  vm_uuid="$1"
  vm_name="$2"
  networks="$(xe vm-param-get uuid="$vm_uuid" param-name=networks 2>/dev/null | clean_one_line)"
  ip="$(printf "%s" "$networks" | first_ip)"
  if [ -n "$ip" ]; then printf "%s" "$ip"; return; fi
  guest_metrics="$(xe vm-param-get uuid="$vm_uuid" param-name=guest-metrics 2>/dev/null | clean_one_line)"
  if [ -n "$guest_metrics" ] && [ "$guest_metrics" != "<not in database>" ]; then
    metrics_networks="$(xe vm-guest-metrics-param-get uuid="$guest_metrics" param-name=networks 2>/dev/null | clean_one_line)"
    ip="$(printf "%s" "$metrics_networks" | first_ip)"
    if [ -n "$ip" ]; then printf "%s" "$ip"; return; fi
  fi
  for key in vrc-ip ip vrc_ip; do
    ip="$(xe vm-param-get uuid="$vm_uuid" param-name=other-config param-key="$key" 2>/dev/null | clean_one_line)"
    if [ -n "$ip" ] && [ "$ip" != "<not in database>" ] && is_managed_ip "$ip"; then
      printf "%s" "$ip"
      return
    fi
  done
  ip="$(xe vm-param-get uuid="$vm_uuid" param-name=xenstore-data param-key=vrc_ip 2>/dev/null | clean_one_line)"
  if [ -n "$ip" ] && [ "$ip" != "<not in database>" ] && is_managed_ip "$ip"; then
    printf "%s" "$ip"
    return
  fi
  infer_ip_from_name "$vm_name"
}
vm_list="$(xe vm-list is-control-domain=false --minimal 2>/dev/null | tr ',' ' ')"
for vm in $vm_list; do
  resident="$(xe vm-param-get uuid="$vm" param-name=resident-on 2>/dev/null | clean_one_line)"
  affinity="$(xe vm-param-get uuid="$vm" param-name=affinity 2>/dev/null | clean_one_line)"
  effective_host="$resident"
  if [ -z "$effective_host" ] || [ "$effective_host" = "<not in database>" ]; then effective_host="$affinity"; fi
  name="$(xe vm-param-get uuid="$vm" param-name=name-label 2>/dev/null | clean_one_line)"
  ip="$(first_search_ip "$vm" "$name")"
  printf 'SEARCH_VM\t%s\t%s\t%s\t%s\n' "$vm" "$name" "$effective_host" "$ip"
done
`;

const VM_LIST_SCRIPT = String.raw`
bytes_to_gib() {
  awk -v b="$1" 'BEGIN { if (b == "" || b == "<not in database>" || b == "0") printf "0"; else printf "%.1f", b/1024/1024/1024 }'
}
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
rfb_console_location() {
  vm_uuid="$1"
  console_uuid="$(xe console-list vm-uuid="$vm_uuid" protocol=RFB --minimal 2>/dev/null | tr ',' '\n' | head -1 | clean_one_line)"
  if [ -n "$console_uuid" ]; then
    xe console-param-get uuid="$console_uuid" param-name=location 2>/dev/null | clean_one_line
  fi
}
num_or_zero() {
  if [ -z "$1" ] || [ "$1" = "<not in database>" ]; then
    printf "0"
  else
    printf "%s" "$1"
  fi
}
first_ip() {
  grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | while read -r candidate; do
    if is_managed_ip "$candidate"; then
      printf "%s" "$candidate"
      break
    fi
  done
}
valid_host_octet() {
  awk -v n="$1" 'BEGIN { exit !(n ~ /^[0-9]+$/ && n > 0 && n < 255) }'
}
is_managed_ip() {
  if [ -z "$VRC_MANAGED_IP_PATTERN" ]; then
    return 0
  fi
  printf "%s" "$1" | grep -Eq "$VRC_MANAGED_IP_PATTERN"
}
infer_ip_from_name() {
  name="$1"
  ip="$(printf "%s" "$name" | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)"
  if [ -n "$ip" ]; then
    last="$(printf "%s" "$ip" | awk -F. '{print $NF}')"
    if valid_host_octet "$last" && is_managed_ip "$ip"; then
      printf "%s" "$ip"
      return
    fi
  fi
  short="$(printf "%s" "$name" | grep -Eo '(^|[^0-9])[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)' | head -1 | grep -Eo '[0-9]{1,3}\.[0-9]{1,3}' | head -1)"
  if [ -n "$short" ]; then
    subnet="$(printf "%s" "$short" | awk -F. '{print $1}')"
    last="$(printf "%s" "$short" | awk -F. '{print $2}')"
    if valid_host_octet "$last"; then
      for prefix in $VRC_SHORT_IP_PREFIXES; do
        prefix_subnet="$(printf "%s" "$prefix" | awk -F. '{print $3}')"
        if [ "$subnet" = "$prefix_subnet" ]; then
          candidate="$prefix.$last"
          if is_managed_ip "$candidate"; then
            printf "%s" "$candidate"
            return
          fi
        fi
      done
      for allowed in $VRC_SHORT_IP_THIRD_OCTETS; do
        if [ "$subnet" != "$allowed" ] || [ -z "$VRC_SHORT_IP_BASE_PREFIX" ]; then
          continue
        fi
        candidate="$VRC_SHORT_IP_BASE_PREFIX.$subnet.$last"
        if is_managed_ip "$candidate"; then
          printf "%s" "$candidate"
          return
        fi
      done
    fi
  fi
  host_only="$(printf "%s" "$name" | grep -Eo '^[0-9]{1,3}([^0-9.]|$)' | head -1 | grep -Eo '[0-9]{1,3}' | head -1)"
  if [ -n "$host_only" ] && [ -n "$VRC_HOST_ONLY_PREFIX" ]; then
    if valid_host_octet "$host_only"; then
      candidate="$VRC_HOST_ONLY_PREFIX.$host_only"
      if is_managed_ip "$candidate"; then
        printf "%s" "$candidate"
      fi
    fi
  fi
}
first_vm_ip() {
  vm_uuid="$1"
  vm_name="$2"
  networks="$(xe vm-param-get uuid="$vm_uuid" param-name=networks 2>/dev/null | clean_one_line)"
  ip="$(printf "%s" "$networks" | first_ip)"
  if [ -n "$ip" ]; then
    printf "%s" "$ip"
    return
  fi
  guest_metrics="$(xe vm-param-get uuid="$vm_uuid" param-name=guest-metrics 2>/dev/null | clean_one_line)"
  if [ -n "$guest_metrics" ] && [ "$guest_metrics" != "<not in database>" ]; then
    metrics_networks="$(xe vm-guest-metrics-param-get uuid="$guest_metrics" param-name=networks 2>/dev/null | clean_one_line)"
    ip="$(printf "%s" "$metrics_networks" | first_ip)"
    if [ -n "$ip" ]; then
      printf "%s" "$ip"
      return
    fi
  fi
  ip="$(xe vm-param-get uuid="$vm_uuid" param-name=other-config param-key=vrc-ip 2>/dev/null | clean_one_line)"
  if [ -n "$ip" ] && [ "$ip" != "<not in database>" ] && is_managed_ip "$ip"; then
    printf "%s" "$ip"
    return
  fi
  for key in ip vrc_ip; do
    ip="$(xe vm-param-get uuid="$vm_uuid" param-name=other-config param-key="$key" 2>/dev/null | clean_one_line)"
    if [ -n "$ip" ] && [ "$ip" != "<not in database>" ] && is_managed_ip "$ip"; then
      printf "%s" "$ip"
      return
    fi
  done
  ip="$(xe vm-param-get uuid="$vm_uuid" param-name=xenstore-data param-key=vrc_ip 2>/dev/null | clean_one_line)"
  if [ -n "$ip" ] && [ "$ip" != "<not in database>" ] && is_managed_ip "$ip"; then
    printf "%s" "$ip"
    return
  fi
  pv_args="$(xe vm-param-get uuid="$vm_uuid" param-name=PV-args 2>/dev/null | clean_one_line)"
  ip="$(printf "%s" "$pv_args" | sed -n 's/.*\(^\| \)ip=\([0-9][0-9.]*\)::.*/\2/p' | head -1)"
  if [ -n "$ip" ] && is_managed_ip "$ip"; then
    printf "%s" "$ip"
    return
  fi
  infer_ip_from_name "$vm_name"
}
compact_os_version() {
  raw="$1"
  if [ -z "$raw" ] || [ "$raw" = "<not in database>" ]; then
    return
  fi
  name="$(printf "%s" "$raw" | sed -n 's/.*name: \([^;]*\).*/\1/p' | clean_one_line)"
  if [ -n "$name" ] && ! printf "%s" "$name" | grep -Eq '^(Linux )?[0-9]+\.[0-9]+\.[0-9]+'; then
    printf "%s" "$name"
    return
  fi
  distro="$(printf "%s" "$raw" | sed -n 's/.*distro: \([^;]*\).*/\1/p' | clean_one_line)"
  major="$(printf "%s" "$raw" | sed -n 's/.*major: \([^;]*\).*/\1/p' | clean_one_line)"
  minor="$(printf "%s" "$raw" | sed -n 's/.*minor: \([^;]*\).*/\1/p' | clean_one_line)"
  if [ -n "$distro" ] && [ "$distro" != "unknown" ]; then
    printf "%s %s" "$distro" "$major.$minor" | sed 's/ \\.$//; s/\\.0$//; s/ $//'
    return
  fi
  if [ -n "$name" ]; then
    printf "%s" "$name"
  fi
}
compact_template_os_name() {
  raw="$(printf "%s" "$1" | clean_one_line)"
  if [ -z "$raw" ] || [ "$raw" = "<not in database>" ]; then
    return
  fi
  if printf "%s" "$raw" | grep -Eiq 'other install media|install media|unknown'; then
    return
  fi
  printf "%s" "$raw" | sed 's/[[:space:]]*(64-bit)[[:space:]]*/ /Ig; s/[[:space:]]*(32-bit)[[:space:]]*/ /Ig; s/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
guest_os_label() {
  vm_uuid="$1"
  os_version="$(xe vm-param-get uuid="$vm_uuid" param-name=os-version 2>/dev/null | clean_one_line)"
  guest_os="$(compact_os_version "$os_version")"
  if [ -n "$guest_os" ]; then
    printf "%s" "$guest_os"
    return
  fi
  for key in vrc-guest-os vrc_guest_os guest-os guest_os; do
    configured_os="$(xe vm-param-get uuid="$vm_uuid" param-name=other-config param-key="$key" 2>/dev/null | clean_one_line)"
    configured_os="$(compact_template_os_name "$configured_os")"
    if [ -n "$configured_os" ]; then
      printf "%s" "$configured_os"
      return
    fi
  done
  other_config="$(xe vm-param-get uuid="$vm_uuid" param-name=other-config 2>/dev/null | clean_one_line)"
  template_name="$(printf "%s" "$other_config" | sed -n 's/.*base_template_name: \([^;]*\).*/\1/p' | clean_one_line)"
  template_os="$(compact_template_os_name "$template_name")"
  if [ -n "$template_os" ]; then
    printf "%s" "$template_os"
    return
  fi
}
collect_vm_disk_info() {
  vm_uuid="$1"
  total="0"
  count="0"
  summary=""
  for vbd in $(xe vbd-list vm-uuid="$vm_uuid" type=Disk --minimal 2>/dev/null | tr ',' ' '); do
    vdi="$(xe vbd-param-get uuid="$vbd" param-name=vdi-uuid 2>/dev/null | clean_one_line)"
    if [ -z "$vdi" ] || [ "$vdi" = "<not in database>" ]; then
      continue
    fi
    size="$(xe vdi-param-get uuid="$vdi" param-name=virtual-size 2>/dev/null | clean_one_line)"
    if echo "$size" | awk '{ exit !($1 ~ /^[0-9]+$/) }'; then
      total="$(awk -v a="$total" -v b="$size" 'BEGIN { printf "%.0f", a + b }')"
      count=$((count+1))
      size_gib="$(bytes_to_gib "$size")"
      if [ -z "$summary" ]; then
        summary="$size_gib GiB"
      else
        summary="$summary + $size_gib GiB"
      fi
    fi
  done
  printf "%s\t%s\t%s" "$total" "$count" "$summary"
}
guest_tools_status() {
  vm_uuid="$1"
  guest_metrics="$(xe vm-param-get uuid="$vm_uuid" param-name=guest-metrics 2>/dev/null | clean_one_line)"
  if [ -n "$guest_metrics" ] && [ "$guest_metrics" != "<not in database>" ]; then
    pv_drivers="$(xe vm-guest-metrics-param-get uuid="$guest_metrics" param-name=PV-drivers-detected 2>/dev/null | clean_one_line)"
    if [ "$pv_drivers" = "true" ]; then printf "available"; return; fi
    if [ "$pv_drivers" = "false" ]; then printf "unavailable"; return; fi
  fi
  # Some XenServer/Citrix Hypervisor pools omit guest-metrics even when the guest
  # agent reports guest-only data sources, so keep this as a version-neutral fallback.
  guest_memory="$(xe vm-data-source-query uuid="$vm_uuid" data-source=memory_internal_free 2>/dev/null | clean_one_line)"
  if printf "%s" "$guest_memory" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    printf "available"
    return
  fi
  printf "unknown"
}
host_count="$(xe host-list --minimal 2>/dev/null | tr ',' ' ' | wc -w | awk '{print $1}')"
vm_list="$(xe vm-list is-control-domain=false --minimal 2>/dev/null | tr ',' ' ')"
for vm in $vm_list; do
  resident="$(xe vm-param-get uuid="$vm" param-name=resident-on 2>/dev/null | clean_one_line)"
  power="$(xe vm-param-get uuid="$vm" param-name=power-state 2>/dev/null | clean_one_line)"
  affinity="$(xe vm-param-get uuid="$vm" param-name=affinity 2>/dev/null | clean_one_line)"
  include_vm="true"
  if [ -n "$VRC_HOST_ID" ]; then
    include_vm="false"
    if [ "$resident" = "$VRC_HOST_ID" ]; then
      include_vm="true"
    elif [ "$power" = "halted" ] && [ "$affinity" = "$VRC_HOST_ID" ]; then
      include_vm="true"
    elif [ "$power" = "halted" ] && [ "$host_count" = "1" ] && { [ -z "$affinity" ] || [ "$affinity" = "<not in database>" ]; }; then
      include_vm="true"
    fi
  fi
  if [ "$include_vm" != "true" ]; then
    continue
  fi
  name="$(xe vm-param-get uuid="$vm" param-name=name-label 2>/dev/null | clean_one_line)"
  first_guest_ip="$(first_vm_ip "$vm" "$name")"
  if [ -n "$VRC_KEYWORD" ]; then
    search_text="$name $first_guest_ip"
    if printf "%s" "$VRC_KEYWORD" | grep -Eq '^[A-Fa-f0-9-]{8,}$'; then
      search_text="$search_text $vm"
    fi
    if ! printf "%s" "$search_text" | grep -Fqi -- "$VRC_KEYWORD"; then
      continue
    fi
  fi
  vcpu_max="$(xe vm-param-get uuid="$vm" param-name=VCPUs-max 2>/dev/null | clean_one_line)"
  vcpu_start="$(xe vm-param-get uuid="$vm" param-name=VCPUs-at-startup 2>/dev/null | clean_one_line)"
  vcpu_live="$(xe vm-param-get uuid="$vm" param-name=VCPUs-number 2>/dev/null | clean_one_line)"
  vcpu_count="$vcpu_max"
  if [ -z "$vcpu_count" ] || [ "$vcpu_count" = "0" ] || [ "$vcpu_count" = "<not in database>" ]; then
    vcpu_count="$vcpu_start"
  fi
  if [ -z "$vcpu_count" ] || [ "$vcpu_count" = "0" ] || [ "$vcpu_count" = "<not in database>" ]; then
    vcpu_count="$vcpu_live"
  fi
  mem_dyn_max="$(xe vm-param-get uuid="$vm" param-name=memory-dynamic-max 2>/dev/null | clean_one_line)"
  guest_os="$(guest_os_label "$vm")"
  disk_info="$(collect_vm_disk_info "$vm")"
  console_location="$(rfb_console_location "$vm")"
  tools_status="$(guest_tools_status "$vm")"
  effective_host="$resident"
  if [ -z "$effective_host" ] || [ "$effective_host" = "<not in database>" ]; then
    effective_host="$affinity"
  fi
  printf 'VM\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$vm" "$name" "$power" "$(num_or_zero "$vcpu_count")" "$(num_or_zero "$vcpu_start")" "$(bytes_to_gib "$mem_dyn_max")" "$disk_info" "$effective_host" "$first_guest_ip" "$guest_os" "$console_location" "$tools_status"
done
`;

const VM_DISKS_SCRIPT = String.raw`
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
num_or_zero() {
  if [ -z "$1" ] || [ "$1" = "<not in database>" ]; then
    printf "0"
  else
    printf "%s" "$1"
  fi
}
if [ -z "$VRC_VM_UUID" ]; then
  exit 0
fi
for vbd in $(xe vbd-list vm-uuid="$VRC_VM_UUID" type=Disk --minimal 2>/dev/null | tr ',' ' '); do
  vdi="$(xe vbd-param-get uuid="$vbd" param-name=vdi-uuid 2>/dev/null | clean_one_line)"
  if [ -z "$vdi" ] || [ "$vdi" = "<not in database>" ]; then
    continue
  fi
  device="$(xe vbd-param-get uuid="$vbd" param-name=userdevice 2>/dev/null | clean_one_line)"
  label="$(xe vdi-param-get uuid="$vdi" param-name=name-label 2>/dev/null | clean_one_line)"
  size="$(xe vdi-param-get uuid="$vdi" param-name=virtual-size 2>/dev/null | clean_one_line)"
  sr_uuid="$(xe vdi-param-get uuid="$vdi" param-name=sr-uuid 2>/dev/null | clean_one_line)"
  allowed_operations="$(xe vdi-param-get uuid="$vdi" param-name=allowed-operations 2>/dev/null | clean_one_line)"
  online_resize_supported="false"
  if printf '%s' "$allowed_operations" | grep -Eq '(^|;[[:space:]]*)resize([[:space:]]*;|$)'; then
    online_resize_supported="true"
  fi
  sr_name=""
  if [ -n "$sr_uuid" ] && [ "$sr_uuid" != "<not in database>" ]; then
    sr_name="$(xe sr-param-get uuid="$sr_uuid" param-name=name-label 2>/dev/null | clean_one_line)"
  fi
  printf 'DISK\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$vdi" "$VRC_VM_UUID" "$device" "$label" "$(num_or_zero "$size")" "$sr_uuid" "$sr_name" "$online_resize_supported"
done
`;

const VM_ACTION_SCRIPT = String.raw`
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
if [ -z "$VRC_VM_UUID" ] || [ -z "$VRC_VM_ACTION" ]; then
  echo "缺少 VM 或操作参数" >&2
  exit 2
fi
name="$(xe vm-param-get uuid="$VRC_VM_UUID" param-name=name-label 2>/dev/null | clean_one_line)"
power="$(xe vm-param-get uuid="$VRC_VM_UUID" param-name=power-state 2>/dev/null | clean_one_line)"
if [ -z "$name" ]; then
  echo "未找到虚拟机：$VRC_VM_UUID" >&2
  exit 3
fi
case "$VRC_VM_ACTION" in
  start)
    if [ "$power" = "running" ]; then
      echo "虚拟机已在运行：$name" >&2
      exit 4
    fi
    forced="false"
    if ! xe vm-start uuid="$VRC_VM_UUID"; then
      xe vm-start uuid="$VRC_VM_UUID" force=true
      forced="true"
    fi
    ;;
  shutdown)
    if [ "$power" != "running" ]; then
      echo "虚拟机未运行，无需关机：$name" >&2
      exit 4
    fi
    forced="false"
    shutdown_timeout="$VRC_VM_SHUTDOWN_TIMEOUT_SECONDS"
    case "$shutdown_timeout" in
      ''|*[!0-9]*) shutdown_timeout="600" ;;
    esac
    graceful_shutdown=""
    if command -v timeout >/dev/null 2>&1; then
      timeout "$shutdown_timeout"s xe vm-shutdown uuid="$VRC_VM_UUID" || graceful_shutdown="failed"
    else
      xe vm-shutdown uuid="$VRC_VM_UUID" || graceful_shutdown="failed"
    fi
    if [ "$graceful_shutdown" = "failed" ]; then
      if [ "$VRC_VM_FORCE_ON_SHUTDOWN_FAILURE" != "false" ]; then
        xe vm-shutdown uuid="$VRC_VM_UUID" force=true
        forced="true"
      else
        echo "虚拟机关机超时或失败，当前策略不允许强制关机：$name" >&2
        exit 5
      fi
    fi
    ;;
  forceReboot)
    if [ "$power" != "running" ]; then
      echo "虚拟机未运行，不能强制重启：$name" >&2
      exit 4
    fi
    xe vm-shutdown uuid="$VRC_VM_UUID" force=true
    if ! xe vm-start uuid="$VRC_VM_UUID"; then
      xe vm-start uuid="$VRC_VM_UUID" force=true
    fi
    forced="true"
    ;;
  delete)
    if [ "$power" = "running" ]; then
      echo "虚拟机正在运行，请先关机后再删除：$name" >&2
      exit 4
    fi
    xe vm-uninstall uuid="$VRC_VM_UUID" force=true
    ;;
  *)
    echo "不支持的操作：$VRC_VM_ACTION" >&2
    exit 2
    ;;
esac
if [ -z "$forced" ]; then
  forced="false"
fi
printf 'OK\t%s\t%s\t%s\t%s\n' "$VRC_VM_ACTION" "$VRC_VM_UUID" "$name" "$forced"
`;

const VM_RESIZE_SCRIPT = String.raw`
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
require_positive_integer() {
  label="$1"
  value="$2"
  if ! printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'; then
    echo "$label 必须是正整数" >&2
    exit 2
  fi
}
vm_uuid="$VRC_VM_UUID"
if [ -z "$vm_uuid" ]; then
  echo "缺少虚拟机 UUID" >&2
  exit 2
fi
name="$(xe vm-param-get uuid="$vm_uuid" param-name=name-label 2>/dev/null | clean_one_line)"
power_before="$(xe vm-param-get uuid="$vm_uuid" param-name=power-state 2>/dev/null | clean_one_line)"
if [ -z "$name" ]; then
  echo "未找到虚拟机：$vm_uuid" >&2
  exit 3
fi
old_cpu="$(xe vm-param-get uuid="$vm_uuid" param-name=VCPUs-max 2>/dev/null | clean_one_line)"
old_memory="$(xe vm-param-get uuid="$vm_uuid" param-name=memory-dynamic-max 2>/dev/null | clean_one_line)"
require_positive_integer "当前 CPU" "$old_cpu"
require_positive_integer "当前内存" "$old_memory"
target_cpu="$VRC_CPU_TARGET"
target_memory="$VRC_MEMORY_TARGET_BYTES"
disk_mode="$VRC_DISK_MODE"
if [ -z "$target_cpu" ]; then target_cpu="$old_cpu"; fi
if [ -z "$target_memory" ]; then target_memory="$old_memory"; fi
require_positive_integer "目标 CPU" "$target_cpu"
require_positive_integer "目标内存" "$target_memory"
if [ "$target_cpu" -lt "$old_cpu" ]; then
  echo "不允许缩减 CPU：当前 $old_cpu，目标 $target_cpu" >&2
  exit 4
fi
if [ "$target_memory" -lt "$old_memory" ]; then
  echo "不允许缩减内存：当前 $old_memory，目标 $target_memory" >&2
  exit 4
fi
needs_shutdown="false"
if [ "$power_before" = "running" ] && { [ "$target_cpu" -gt "$old_cpu" ] || [ "$target_memory" -gt "$old_memory" ]; }; then
  needs_shutdown="true"
fi
if [ "$power_before" = "running" ] && [ "$disk_mode" = "extend" ] && [ "$VRC_DISK_ONLINE_RESIZE_SUPPORTED" != "true" ]; then
  needs_shutdown="true"
fi
stopped="false"
restarted="false"
if [ "$needs_shutdown" = "true" ]; then
  if [ "$VRC_ALLOW_SHUTDOWN" != "true" ]; then
    echo "当前 XenServer 资源不支持在线扩容，需要先正常关机" >&2
    exit 5
  fi
  xe vm-shutdown uuid="$vm_uuid" >/dev/null
  stopped="true"
fi
if [ "$target_cpu" -gt "$old_cpu" ]; then
  xe vm-param-set uuid="$vm_uuid" VCPUs-max="$target_cpu" >/dev/null
  xe vm-param-set uuid="$vm_uuid" VCPUs-at-startup="$target_cpu" >/dev/null
fi
if [ "$target_memory" -gt "$old_memory" ]; then
  xe vm-memory-limits-set uuid="$vm_uuid" static-min=134217728 dynamic-min="$target_memory" dynamic-max="$target_memory" static-max="$target_memory" >/dev/null
fi
if [ "$disk_mode" = "extend" ]; then
  disk_uuid="$VRC_DISK_UUID"
  target_disk_size="$VRC_DISK_SIZE_BYTES"
  require_positive_integer "目标磁盘容量" "$target_disk_size"
  attached="$(xe vbd-list vm-uuid="$vm_uuid" vdi-uuid="$disk_uuid" type=Disk params=uuid --minimal 2>/dev/null | clean_one_line)"
  if [ -z "$disk_uuid" ] || [ -z "$attached" ]; then
    echo "目标磁盘不属于当前虚拟机" >&2
    exit 6
  fi
  old_disk_size="$(xe vdi-param-get uuid="$disk_uuid" param-name=virtual-size 2>/dev/null | clean_one_line)"
  require_positive_integer "当前磁盘容量" "$old_disk_size"
  if [ "$target_disk_size" -lt "$old_disk_size" ]; then
    echo "不允许缩减磁盘：当前 $old_disk_size，目标 $target_disk_size" >&2
    exit 4
  fi
  if [ "$target_disk_size" -gt "$old_disk_size" ]; then
    if [ "$power_before" = "running" ] && [ "$stopped" != "true" ]; then
      xe vdi-resize uuid="$disk_uuid" disk-size="$target_disk_size" online=true >/dev/null
    else
      xe vdi-resize uuid="$disk_uuid" disk-size="$target_disk_size" >/dev/null
    fi
    actual_disk_size="$(xe vdi-param-get uuid="$disk_uuid" param-name=virtual-size 2>/dev/null | clean_one_line)"
    require_positive_integer "扩容后磁盘容量" "$actual_disk_size"
    if [ "$actual_disk_size" -lt "$target_disk_size" ]; then
      echo "磁盘扩容未生效：目标 $target_disk_size，平台回读 $actual_disk_size" >&2
      exit 9
    fi
  fi
elif [ "$disk_mode" = "add" ]; then
  sr_uuid="$VRC_DISK_SR_UUID"
  new_disk_size="$VRC_DISK_SIZE_BYTES"
  require_positive_integer "新磁盘容量" "$new_disk_size"
  if [ -z "$sr_uuid" ] || ! xe sr-param-get uuid="$sr_uuid" param-name=uuid >/dev/null 2>&1; then
    echo "新增磁盘缺少有效的存储 SR" >&2
    exit 6
  fi
  new_vdi="$(xe vdi-create name-label="$VRC_NEW_DISK_NAME" sr-uuid="$sr_uuid" virtual-size="$new_disk_size" type=user)"
  if [ -z "$new_vdi" ]; then
    echo "创建新 VDI 失败" >&2
    exit 7
  fi
  used_devices=" $(xe vbd-list vm-uuid="$vm_uuid" type=Disk params=userdevice --minimal 2>/dev/null | tr ',' ' ') "
  new_device=""
  candidate="0"
  while [ "$candidate" -le 15 ]; do
    if ! printf '%s' "$used_devices" | grep -Eq "[[:space:]]$candidate[[:space:]]"; then
      new_device="$candidate"
      break
    fi
    candidate=$((candidate + 1))
  done
  if [ -z "$new_device" ]; then
    xe vdi-destroy uuid="$new_vdi" >/dev/null 2>&1 || true
    echo "虚拟机没有可用的磁盘设备位" >&2
    exit 7
  fi
  new_vbd="$(xe vbd-create vm-uuid="$vm_uuid" vdi-uuid="$new_vdi" device="$new_device" bootable=false mode=RW type=Disk 2>/dev/null || true)"
  if [ -z "$new_vbd" ]; then
    xe vdi-destroy uuid="$new_vdi" >/dev/null 2>&1 || true
    echo "挂载新 VDI 失败" >&2
    exit 7
  fi
  if [ "$power_before" = "running" ] && [ "$stopped" != "true" ]; then
    if ! xe vbd-plug uuid="$new_vbd" >/dev/null 2>&1; then
      xe vbd-destroy uuid="$new_vbd" >/dev/null 2>&1 || true
      xe vdi-destroy uuid="$new_vdi" >/dev/null 2>&1 || true
      echo "运行中的虚拟机无法热挂载新磁盘，本次新建磁盘已回滚" >&2
      exit 8
    fi
  fi
elif [ -n "$disk_mode" ]; then
  echo "不支持的磁盘扩容方式：$disk_mode" >&2
  exit 2
fi
if [ "$stopped" = "true" ] && [ "$VRC_RESTART_AFTER_RESIZE" = "true" ]; then
  xe vm-start uuid="$vm_uuid" >/dev/null
  restarted="true"
fi
new_cpu="$(xe vm-param-get uuid="$vm_uuid" param-name=VCPUs-max 2>/dev/null | clean_one_line)"
new_memory="$(xe vm-param-get uuid="$vm_uuid" param-name=memory-dynamic-max 2>/dev/null | clean_one_line)"
power_after="$(xe vm-param-get uuid="$vm_uuid" param-name=power-state 2>/dev/null | clean_one_line)"
printf 'OK\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$vm_uuid" "$name" "$old_cpu" "$new_cpu" "$old_memory" "$new_memory" "$power_after" "$stopped" "$restarted"
`;

const VM_RENAME_SCRIPT = String.raw`
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
if [ -z "$VRC_VM_UUID" ] || [ -z "$VRC_VM_CURRENT_NAME" ] || [ -z "$VRC_VM_NEW_NAME" ]; then
  echo "缺少虚拟机改名参数" >&2
  exit 2
fi
actual_name="$(xe vm-param-get uuid="$VRC_VM_UUID" param-name=name-label 2>/dev/null | clean_one_line)"
if [ -z "$actual_name" ]; then
  echo "未找到虚拟机：$VRC_VM_UUID" >&2
  exit 3
fi
if [ "$actual_name" != "$VRC_VM_CURRENT_NAME" ]; then
  echo "虚拟机名称已变更为“$actual_name”，请刷新列表后重试。" >&2
  exit 4
fi
duplicate_ids="$(xe vm-list name-label="$VRC_VM_NEW_NAME" params=uuid --minimal 2>/dev/null || true)"
for duplicate_id in $(printf '%s' "$duplicate_ids" | tr ',' ' '); do
  if [ -n "$duplicate_id" ] && [ "$duplicate_id" != "$VRC_VM_UUID" ]; then
    echo "当前资源池内已存在名为“$VRC_VM_NEW_NAME”的虚拟机。" >&2
    exit 5
  fi
done
xe vm-param-set uuid="$VRC_VM_UUID" name-label="$VRC_VM_NEW_NAME" >/dev/null
updated_name="$(xe vm-param-get uuid="$VRC_VM_UUID" param-name=name-label 2>/dev/null | clean_one_line)"
if [ "$updated_name" != "$VRC_VM_NEW_NAME" ]; then
  echo "XenServer 已接受改名请求，但名称校验未通过。" >&2
  exit 6
fi
printf 'OK\t%s\t%s\n' "$actual_name" "$updated_name"
`;

const VM_CREATE_SCRIPT = String.raw`
vrc_now_ms() {
  now="$(date +%s%3N 2>/dev/null || date +%s000)"
  case "$now" in
    *N*) date +%s000 ;;
    *) printf "%s" "$now" ;;
  esac
}
vrc_timing_start() {
  VRC_TIMING_STEP="$1"
  VRC_TIMING_STARTED="$(vrc_now_ms)"
}
vrc_timing_end() {
  ended="$(vrc_now_ms)"
  elapsed="$(awk -v s="$VRC_TIMING_STARTED" -v e="$ended" 'BEGIN { printf "%.0f", e - s }')"
  printf 'TIMING\t%s\t%s\n' "$VRC_TIMING_STEP" "$elapsed"
}
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
first_uuid() {
  tr ',' '\n' | sed '/^[[:space:]]*$/d' | head -1 | clean_one_line
}
require_value() {
  if [ -z "$2" ]; then
    echo "$1不能为空" >&2
    exit 2
  fi
}
is_number() {
  echo "$1" | awk '{ exit !($1 ~ /^[0-9]+$/ && $1 > 0) }'
}
is_pif_usable() {
  pif_uuid="$1"
  pif_device="$(xe pif-param-get uuid="$pif_uuid" param-name=device 2>/dev/null | clean_one_line)"
  pif_attached="$(xe pif-param-get uuid="$pif_uuid" param-name=currently-attached 2>/dev/null | clean_one_line)"
  if [ "$pif_attached" != "true" ]; then
    return 1
  fi
  if [ -n "$pif_device" ] && [ -r "/sys/class/net/$pif_device/carrier" ]; then
    carrier="$(cat "/sys/class/net/$pif_device/carrier" 2>/dev/null || true)"
    if [ "$carrier" != "1" ]; then
      return 1
    fi
  fi
  return 0
}
is_network_usable_on_host() {
  network_uuid="$1"
  if [ -z "$network_uuid" ] || [ "$network_uuid" = "<not in database>" ]; then
    return 1
  fi
  if [ -z "$VRC_HOST_UUID" ]; then
    return 0
  fi
  for pif_uuid in $(xe pif-list host-uuid="$VRC_HOST_UUID" network-uuid="$network_uuid" --minimal 2>/dev/null | tr ',' ' '); do
    if is_pif_usable "$pif_uuid"; then
      return 0
    fi
  done
  return 1
}
is_network_attached_on_host() {
  network_uuid="$1"
  if [ -z "$network_uuid" ] || [ "$network_uuid" = "<not in database>" ]; then
    return 1
  fi
  if [ -z "$VRC_HOST_UUID" ]; then
    return 0
  fi
  for pif_uuid in $(xe pif-list host-uuid="$VRC_HOST_UUID" network-uuid="$network_uuid" --minimal 2>/dev/null | tr ',' ' '); do
    pif_attached="$(xe pif-param-get uuid="$pif_uuid" param-name=currently-attached 2>/dev/null | clean_one_line)"
    if [ "$pif_attached" = "true" ]; then
      return 0
    fi
  done
  return 1
}
find_template() {
  if [ -n "$VRC_TEMPLATE_NAME" ]; then
    template="$(xe template-list name-label="$VRC_TEMPLATE_NAME" --minimal 2>/dev/null | first_uuid)"
    if [ -n "$template" ]; then
      printf "%s" "$VRC_TEMPLATE_NAME"
      return
    fi
  fi
  for name in "CentOS 7" "CentOS 7 (64-bit)" "Other install media" "Other install media (64-bit)"; do
    template="$(xe template-list name-label="$name" --minimal 2>/dev/null | first_uuid)"
    if [ -n "$template" ]; then
      printf "%s" "$name"
      return
    fi
  done
}
find_sr() {
  best_sr=""
  best_free="-1"
  for sr in $(xe sr-list --minimal 2>/dev/null | tr ',' ' '); do
    type="$(xe sr-param-get uuid="$sr" param-name=type 2>/dev/null | clean_one_line)"
    content="$(xe sr-param-get uuid="$sr" param-name=content-type 2>/dev/null | clean_one_line)"
    physical="$(xe sr-param-get uuid="$sr" param-name=physical-size 2>/dev/null | clean_one_line)"
    used="$(xe sr-param-get uuid="$sr" param-name=physical-utilisation 2>/dev/null | clean_one_line)"
    if [ "$type" = "iso" ] || [ "$content" = "iso" ]; then
      continue
    fi
    if ! is_number "$physical"; then
      continue
    fi
    if ! is_number "$used"; then
      used="0"
    fi
    free="$(awk -v p="$physical" -v u="$used" 'BEGIN { printf "%.0f", p - u }')"
    if awk -v f="$free" -v b="$best_free" 'BEGIN { exit !(f > b) }'; then
      best_free="$free"
      best_sr="$sr"
    fi
  done
  printf "%s" "$best_sr"
}
find_network() {
  ip_prefix="$(printf "%s" "$VRC_IP" | awk -F. 'NF == 4 { printf "%s.%s.%s.", $1, $2, $3 }')"
  if [ -n "$ip_prefix" ] && [ -n "$VRC_HOST_UUID" ]; then
    for peer_vm in $(xe vm-list is-control-domain=false --minimal 2>/dev/null | tr ',' ' '); do
      if [ "$peer_vm" = "$vm_uuid" ]; then
        continue
      fi
      resident_host="$(xe vm-param-get uuid="$peer_vm" param-name=resident-on 2>/dev/null | clean_one_line)"
      if [ "$resident_host" != "$VRC_HOST_UUID" ]; then
        continue
      fi
      peer_networks="$(xe vm-param-get uuid="$peer_vm" param-name=networks 2>/dev/null | clean_one_line)"
      case "$peer_networks" in
        *"$ip_prefix"*)
          for peer_vif in $(xe vif-list vm-uuid="$peer_vm" currently-attached=true --minimal 2>/dev/null | tr ',' ' '); do
            peer_network="$(xe vif-param-get uuid="$peer_vif" param-name=network-uuid 2>/dev/null | clean_one_line)"
            if is_network_usable_on_host "$peer_network"; then
              printf "%s" "$peer_network"
              return
            fi
          done
          ;;
      esac
    done
  fi
  if [ -n "$VRC_NETWORK_NAME" ]; then
    network="$(xe network-list name-label="$VRC_NETWORK_NAME" --minimal 2>/dev/null | first_uuid)"
    if [ -n "$network" ] && is_network_usable_on_host "$network"; then
      printf "%s" "$network"
      return
    fi
    echo "指定网络不可用或物理链路未连通：$VRC_NETWORK_NAME" >&2
    exit 3
  fi
  while IFS='|' read -r prefix device; do
    if [ -z "$prefix" ] || [ -z "$device" ]; then
      continue
    fi
    case "$VRC_IP" in
      "$prefix"*)
        if [ -n "$VRC_HOST_UUID" ]; then
          pif="$(xe pif-list host-uuid="$VRC_HOST_UUID" device="$device" --minimal 2>/dev/null | first_uuid)"
        else
          pif="$(xe pif-list device="$device" --minimal 2>/dev/null | first_uuid)"
        fi
        if [ -n "$pif" ]; then
          if ! is_pif_usable "$pif"; then
            continue
          fi
          network="$(xe pif-param-get uuid="$pif" param-name=network-uuid 2>/dev/null | clean_one_line)"
          if [ -n "$network" ] && [ "$network" != "<not in database>" ]; then
            printf "%s" "$network"
            return
          fi
        fi
        ;;
    esac
  done <<VRC_NETWORK_RULES
$VRC_XENSERVER_NETWORK_RULES
VRC_NETWORK_RULES
  if [ -n "$VRC_HOST_UUID" ]; then
    pif="$(xe pif-list host-uuid="$VRC_HOST_UUID" management=true --minimal 2>/dev/null | first_uuid)"
    if [ -n "$pif" ]; then
      network="$(xe pif-param-get uuid="$pif" param-name=network-uuid 2>/dev/null | clean_one_line)"
      if [ -n "$network" ] && [ "$network" != "<not in database>" ]; then
        printf "%s" "$network"
        return
      fi
    fi
  fi
  xe network-list --minimal 2>/dev/null | first_uuid
}
ensure_disk() {
  vm_uuid="$1"
  sr_uuid="$2"
  disk_bytes="$3"
  disk_vbd="$(xe vbd-list vm-uuid="$vm_uuid" type=Disk --minimal 2>/dev/null | first_uuid)"
  if [ -n "$disk_vbd" ]; then
    vdi_uuid="$(xe vbd-param-get uuid="$disk_vbd" param-name=vdi-uuid 2>/dev/null | clean_one_line)"
    if [ -n "$vdi_uuid" ] && [ "$vdi_uuid" != "<not in database>" ]; then
      current_size="$(xe vdi-param-get uuid="$vdi_uuid" param-name=virtual-size 2>/dev/null | clean_one_line)"
      if ! is_number "$current_size" || awk -v target="$disk_bytes" -v current="$current_size" 'BEGIN { exit !(target > current) }'; then
        xe vdi-resize uuid="$vdi_uuid" disk-size="$disk_bytes" >/dev/null
      fi
      return
    fi
  fi
  vdi_uuid="$(xe vdi-create name-label="$VRC_VM_NAME disk0" sr-uuid="$sr_uuid" virtual-size="$disk_bytes" type=user)"
  xe vbd-create vm-uuid="$vm_uuid" vdi-uuid="$vdi_uuid" device=0 bootable=true mode=RW type=Disk >/dev/null
}
apply_vrc_guest_config() {
  vm_uuid="$1"
  xe vm-param-set uuid="$vm_uuid" xenstore-data:vrc_vm_name="$VRC_VM_NAME" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" xenstore-data:vrc_ip="$VRC_IP" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" xenstore-data:vrc_gateway="$VRC_GATEWAY" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" xenstore-data:vrc_netmask="$VRC_NETMASK" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" xenstore-data:vrc_dns="$VRC_DNS" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" xenstore-data:vrc_login_username="$VRC_LOGIN_USERNAME" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" other-config:vrc-provision-mode=template >/dev/null 2>&1 || true
}
ensure_network() {
  vm_uuid="$1"
  network_uuid="$2"
  if [ -z "$network_uuid" ]; then
    return
  fi
  vif_args="vm-uuid=$vm_uuid network-uuid=$network_uuid device=0"
  if [ -n "$VRC_MAC" ]; then
    vif_args="$vif_args mac=$VRC_MAC"
  fi
  existing="$(xe vif-list vm-uuid="$vm_uuid" --minimal 2>/dev/null | first_uuid)"
  if [ -z "$existing" ]; then
    xe vif-create $vif_args >/dev/null
    return
  fi
  current_network="$(xe vif-param-get uuid="$existing" param-name=network-uuid 2>/dev/null | clean_one_line)"
  current_mac="$(xe vif-param-get uuid="$existing" param-name=MAC 2>/dev/null | clean_one_line | tr '[:upper:]' '[:lower:]')"
  expected_mac="$(printf "%s" "$VRC_MAC" | tr '[:upper:]' '[:lower:]')"
  if [ "$current_network" != "$network_uuid" ] || { [ -n "$expected_mac" ] && [ "$current_mac" != "$expected_mac" ]; }; then
    xe vif-destroy uuid="$existing" >/dev/null
    xe vif-create $vif_args >/dev/null
  fi
}
attach_iso() {
  vm_uuid="$1"
  iso_uuid="$2"
  cd_vbd="$(xe vbd-list vm-uuid="$vm_uuid" type=CD --minimal 2>/dev/null | first_uuid)"
  if [ -n "$cd_vbd" ]; then
    current="$(xe vbd-param-get uuid="$cd_vbd" param-name=currently-attached 2>/dev/null | clean_one_line)"
    if [ "$current" = "true" ]; then
      xe vbd-eject uuid="$cd_vbd" >/dev/null 2>&1 || true
    fi
    xe vbd-insert uuid="$cd_vbd" vdi-uuid="$iso_uuid" >/dev/null
    return
  fi
  xe vbd-create vm-uuid="$vm_uuid" vdi-uuid="$iso_uuid" device=3 bootable=true mode=RO type=CD >/dev/null
}
attach_iso_auto() {
  vm_uuid="$1"
  iso_uuid="$2"
  bootable="$3"
  cd_vbd="$(xe vbd-list vm-uuid="$vm_uuid" type=CD vdi-uuid="$iso_uuid" --minimal 2>/dev/null | first_uuid)"
  if [ -n "$cd_vbd" ]; then
    xe vbd-param-set uuid="$cd_vbd" bootable="$bootable" >/dev/null 2>&1 || true
    return
  fi
  xe vbd-create vm-uuid="$vm_uuid" vdi-uuid="$iso_uuid" device=autodetect bootable="$bootable" mode=RO type=CD >/dev/null
}
should_use_unattended_install() {
  [ "$VRC_UNATTENDED_INSTALL" = "true" ]
}
prepare_unattended_install() {
  vm_uuid="$1"
  template_name="$2"
  if ! should_use_unattended_install "$template_name"; then
    return
  fi
  require_value "IP" "$VRC_IP"
  require_value "网关" "$VRC_GATEWAY"
  require_value "DNS" "$VRC_DNS"
  require_value "root 密码" "$VRC_ROOT_PASSWORD"
  if [ "$VRC_INSTALL_MEDIA_MODE" = "windows-unattended" ]; then
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-install-mode=windows-unattended >/dev/null 2>&1 || true
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-ip="$VRC_IP" >/dev/null 2>&1 || true
    return
  fi
  if [ "$VRC_INSTALL_MEDIA_MODE" = "offline-iso" ]; then
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-install-mode=offline-iso >/dev/null 2>&1 || true
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-ip="$VRC_IP" >/dev/null 2>&1 || true
    return
  fi
  if [ "$VRC_INSTALL_MEDIA_MODE" = "native-http" ]; then
    require_value "Kickstart URL" "$VRC_INSTALL_KS_URL"
    require_value "安装源 URL" "$VRC_INSTALL_REPO_URL"
    require_value "原生安装参数" "$VRC_INSTALL_ARGS"
    install_args="$VRC_INSTALL_ARGS"
    xe vm-param-set uuid="$vm_uuid" PV-bootloader=eliloader >/dev/null
    # eliloader 会自动追加 other-config:install-args；PV-args 必须为空，避免网络参数被传入两次。
    xe vm-param-set uuid="$vm_uuid" PV-args="" >/dev/null
    xe vm-param-set uuid="$vm_uuid" other-config:install-repository="$VRC_INSTALL_REPO_URL" >/dev/null
    xe vm-param-set uuid="$vm_uuid" other-config:install-distro=rhlike >/dev/null
    xe vm-param-set uuid="$vm_uuid" other-config:install-arch=x86_64 >/dev/null
    xe vm-param-set uuid="$vm_uuid" other-config:install-args="$install_args" >/dev/null
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-install-mode=native-http >/dev/null 2>&1 || true
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-ip="$VRC_IP" >/dev/null 2>&1 || true
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-ks-url="$VRC_INSTALL_KS_URL" >/dev/null 2>&1 || true
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-repo-url="$VRC_INSTALL_REPO_URL" >/dev/null 2>&1 || true
    return
  fi
  # Provider 只消费 VRC 集中安装源 URL，不在 Dom0 生成 ks.cfg 或启动临时 HTTP 服务。
  ifname_arg=""
  if [ -n "$VRC_MAC" ]; then
    ifname_arg="ifname=eth0:$VRC_MAC"
  fi
  if [ "$VRC_INSTALL_MEDIA_MODE" = "cdrom-http-ks" ]; then
    require_value "Kickstart URL" "$VRC_INSTALL_KS_URL"
    xe vm-param-set uuid="$vm_uuid" PV-args="inst.stage2=cdrom inst.ks=$VRC_INSTALL_KS_URL rd.neednet=1 $ifname_arg ip=$VRC_IP::$VRC_GATEWAY:$VRC_NETMASK:vrc:eth0:none bootdev=eth0 ksdevice=eth0" >/dev/null 2>&1 || true
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-install-mode=cdrom-http-ks >/dev/null 2>&1 || true
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-ip="$VRC_IP" >/dev/null 2>&1 || true
    xe vm-param-set uuid="$vm_uuid" other-config:vrc-ks-url="$VRC_INSTALL_KS_URL" >/dev/null 2>&1 || true
    return
  fi
  require_value "Kickstart URL" "$VRC_INSTALL_KS_URL"
  require_value "安装源 URL" "$VRC_INSTALL_REPO_URL"
  xe vm-param-set uuid="$vm_uuid" other-config:install-repository="$VRC_INSTALL_REPO_URL" >/dev/null 2>&1 || true
  xe vm-param-add uuid="$vm_uuid" param-name=other-config install-repository="$VRC_INSTALL_REPO_URL" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" PV-args="inst.repo=$VRC_INSTALL_REPO_URL inst.ks=$VRC_INSTALL_KS_URL rd.neednet=1 $ifname_arg ip=$VRC_IP::$VRC_GATEWAY:$VRC_NETMASK:vrc:eth0:none bootdev=eth0 ksdevice=eth0" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" other-config:vrc-install-mode=kickstart >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" other-config:vrc-ip="$VRC_IP" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" other-config:vrc-ks-url="$VRC_INSTALL_KS_URL" >/dev/null 2>&1 || true
  xe vm-param-set uuid="$vm_uuid" other-config:vrc-repo-url="$VRC_INSTALL_REPO_URL" >/dev/null 2>&1 || true
}

require_value "虚拟机名称" "$VRC_VM_NAME"
require_value "CPU" "$VRC_CPU"
require_value "内存" "$VRC_MEMORY_BYTES"
require_value "硬盘" "$VRC_DISK_BYTES"
if ! is_number "$VRC_CPU" || ! is_number "$VRC_MEMORY_BYTES" || ! is_number "$VRC_DISK_BYTES"; then
  echo "CPU、内存、硬盘必须是正整数" >&2
  exit 2
fi
if xe vm-list name-label="$VRC_VM_NAME" --minimal 2>/dev/null | grep -q .; then
  echo "虚拟机名称已存在：$VRC_VM_NAME" >&2
  exit 3
fi
vrc_timing_start "find-sr"
sr_uuid="$(find_sr)"
vrc_timing_end
if [ -z "$sr_uuid" ]; then
  echo "未找到可写入虚拟磁盘的 SR" >&2
  exit 3
fi
vrc_timing_start "find-network"
network_uuid="$(find_network)"
vrc_timing_end
if [ "$VRC_INSTALL_MEDIA_MODE" != "native-http" ]; then
  require_value "ISO UUID" "$VRC_ISO_UUID"
  vrc_timing_start "verify-iso"
  if ! xe vdi-param-get uuid="$VRC_ISO_UUID" param-name=name-label >/dev/null 2>&1; then
    echo "未找到 ISO：$VRC_ISO_UUID" >&2
    exit 3
  fi
  vrc_timing_end
fi
vrc_timing_start "find-template"
template_name="$(find_template)"
vrc_timing_end
if [ -z "$template_name" ]; then
  echo "未找到可用于 ISO 安装的系统类型：CentOS 7 (64-bit) / Other install media" >&2
  exit 3
fi
vrc_timing_start "vm-install"
vm_uuid="$(xe vm-install template="$template_name" new-name-label="$VRC_VM_NAME" sr-uuid="$sr_uuid")"
vrc_timing_end
if [ -z "$vm_uuid" ]; then
  echo "创建 VM 失败：$VRC_VM_NAME" >&2
  exit 4
fi
vrc_timing_start "configure-vm"
if [ -n "$VRC_HOST_UUID" ]; then
  xe vm-param-set uuid="$vm_uuid" affinity="$VRC_HOST_UUID" >/dev/null
fi
xe vm-param-set uuid="$vm_uuid" VCPUs-max="$VRC_CPU" >/dev/null
xe vm-param-set uuid="$vm_uuid" VCPUs-at-startup="$VRC_CPU" >/dev/null
xe vm-memory-limits-set uuid="$vm_uuid" static-min=134217728 dynamic-min="$VRC_MEMORY_BYTES" dynamic-max="$VRC_MEMORY_BYTES" static-max="$VRC_MEMORY_BYTES" >/dev/null
vrc_timing_end
vrc_timing_start "ensure-disk"
ensure_disk "$vm_uuid" "$sr_uuid" "$VRC_DISK_BYTES"
vrc_timing_end
vrc_timing_start "ensure-network"
ensure_network "$vm_uuid" "$network_uuid"
vrc_timing_end
vrc_timing_start "boot-params"
if [ "$VRC_INSTALL_MEDIA_MODE" = "native-http" ]; then
  xe vm-param-set uuid="$vm_uuid" HVM-boot-policy="" >/dev/null
  prepare_unattended_install "$vm_uuid" "$template_name"
elif [ "$VRC_INSTALL_MEDIA_MODE" = "windows-unattended" ]; then
  xe vm-param-set uuid="$vm_uuid" HVM-boot-policy="BIOS order" >/dev/null 2>&1 || true
  prepare_unattended_install "$vm_uuid" "$template_name"
  # XenServer 6.5 必须自动分配光驱设备；固定 3/4/5 会让 Windows Setup 看不到应答盘。
  attach_iso_auto "$vm_uuid" "$VRC_ISO_UUID" true
  [ -n "$VRC_AUX_ISO_UUID" ] && attach_iso_auto "$vm_uuid" "$VRC_AUX_ISO_UUID" false
  # Tools 只在 WinRM 就绪后换盘挂载，避免第三张光盘挤掉任务级应答介质。
  # Windows PV drivers rely on the Windows device id and template CPU topology after XenServer Tools is installed.
  # Missing Windows platform keys can put Windows Server 2008 R2 into a BSOD recovery loop after Tools reboot.
  xe vm-param-set uuid="$vm_uuid" HVM-boot-params:order=dc platform:device_id=0002 platform:viridian=true platform:cores-per-socket=1 >/dev/null 2>&1 || true
elif should_use_unattended_install "$template_name"; then
  xe vm-param-set uuid="$vm_uuid" HVM-boot-policy="BIOS order" >/dev/null 2>&1 || true
  prepare_unattended_install "$vm_uuid" "$template_name"
  # http-boot/offline 策略生成的辅助 ISO 才包含自动启动参数；没有辅助 ISO 的 cdrom-http-ks 才回退原始安装盘。
  boot_iso_uuid="$VRC_ISO_UUID"
  if [ -n "$VRC_AUX_ISO_UUID" ]; then
    boot_iso_uuid="$VRC_AUX_ISO_UUID"
  fi
  attach_iso "$vm_uuid" "$boot_iso_uuid"
  xe vm-param-set uuid="$vm_uuid" HVM-boot-params:order=dc platform:viridian=false >/dev/null 2>&1 || true
else
  xe vm-param-set uuid="$vm_uuid" HVM-boot-policy="BIOS order" >/dev/null 2>&1 || true
  attach_iso "$vm_uuid" "$VRC_ISO_UUID"
  xe vm-param-set uuid="$vm_uuid" HVM-boot-params:order=dc >/dev/null 2>&1 || true
fi
vrc_timing_end
power="halted"
if [ "$VRC_AUTO_START" = "true" ]; then
  vrc_timing_start "vm-start"
  xe vm-start uuid="$vm_uuid" >/dev/null
  vrc_timing_end
  power="running"
fi
printf 'CREATED\t%s\t%s\t%s\t%s\t%s\n' "$vm_uuid" "$VRC_VM_NAME" "$power" "$VRC_IP" "$VRC_MAC"
`;

const VIRTUAL_DISKS_SCRIPT = String.raw`
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
num_or_zero() {
  if [ -z "$1" ] || [ "$1" = "<not in database>" ]; then
    printf "0"
  else
    printf "%s" "$1"
  fi
}
for vdi in $(xe vdi-list --minimal 2>/dev/null | tr ',' ' '); do
  label="$(xe vdi-param-get uuid="$vdi" param-name=name-label 2>/dev/null | clean_one_line)"
  virtual_size="$(xe vdi-param-get uuid="$vdi" param-name=virtual-size 2>/dev/null | clean_one_line)"
  physical_used="$(xe vdi-param-get uuid="$vdi" param-name=physical-utilisation 2>/dev/null | clean_one_line)"
  sr_uuid="$(xe vdi-param-get uuid="$vdi" param-name=sr-uuid 2>/dev/null | clean_one_line)"
  type="$(xe vdi-param-get uuid="$vdi" param-name=type 2>/dev/null | clean_one_line)"
  readonly="$(xe vdi-param-get uuid="$vdi" param-name=read-only 2>/dev/null | clean_one_line)"
  managed="$(xe vdi-param-get uuid="$vdi" param-name=managed 2>/dev/null | clean_one_line)"
  sr_name=""
  if [ -n "$sr_uuid" ] && [ "$sr_uuid" != "<not in database>" ]; then
    sr_name="$(xe sr-param-get uuid="$sr_uuid" param-name=name-label 2>/dev/null | clean_one_line)"
  fi
  printf 'VDI\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$vdi" "$label" "$(num_or_zero "$virtual_size")" "$(num_or_zero "$physical_used")" "$sr_uuid" "$sr_name" "$type" "$readonly" "$managed"
done
`;

const ISO_IMAGES_SCRIPT = String.raw`
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
num_or_zero() {
  if [ -z "$1" ] || [ "$1" = "<not in database>" ]; then
    printf "0"
  else
    printf "%s" "$1"
  fi
}
sr_list="$(xe sr-list content-type=iso --minimal 2>/dev/null | tr ',' ' ')"
if [ -z "$sr_list" ]; then
  sr_list="$(xe sr-list type=iso --minimal 2>/dev/null | tr ',' ' ')"
fi
if [ -z "$sr_list" ]; then
  sr_list="$(xe sr-list --minimal 2>/dev/null | tr ',' ' ')"
fi
found="0"
emitted=","
emit_iso() {
  vdi="$1"
  sr_filter="$2"
  case "$emitted" in
    *",$vdi,"*) return ;;
  esac
  label="$(xe vdi-param-get uuid="$vdi" param-name=name-label 2>/dev/null | clean_one_line)"
  virtual_size="$(xe vdi-param-get uuid="$vdi" param-name=virtual-size 2>/dev/null | clean_one_line)"
  physical_used="$(xe vdi-param-get uuid="$vdi" param-name=physical-utilisation 2>/dev/null | clean_one_line)"
  sr_uuid="$(xe vdi-param-get uuid="$vdi" param-name=sr-uuid 2>/dev/null | clean_one_line)"
  location="$(xe vdi-param-get uuid="$vdi" param-name=location 2>/dev/null | clean_one_line)"
  if [ -n "$sr_filter" ] && [ "$sr_uuid" != "$sr_filter" ]; then
    return
  fi
  sr_name=""
  sr_desc=""
  sr_shared=""
  sr_type=""
  host_uuid=""
  source_type="iso-library"
  volume_label=""
  if [ -n "$sr_uuid" ] && [ "$sr_uuid" != "<not in database>" ]; then
    sr_name="$(xe sr-param-get uuid="$sr_uuid" param-name=name-label 2>/dev/null | clean_one_line)"
    sr_desc="$(xe sr-param-get uuid="$sr_uuid" param-name=name-description 2>/dev/null | clean_one_line)"
    sr_shared="$(xe sr-param-get uuid="$sr_uuid" param-name=shared 2>/dev/null | clean_one_line)"
    sr_type="$(xe sr-param-get uuid="$sr_uuid" param-name=type 2>/dev/null | clean_one_line)"
  fi
  if [ "$sr_type" = "udev" ] && printf '%s %s' "$sr_name" "$sr_desc" | grep -qi 'dvd'; then
    source_type="host-dvd"
    host_uuid="$(xe pbd-list sr-uuid="$sr_uuid" params=host-uuid --minimal 2>/dev/null | tr ',' '\n' | head -1 | clean_one_line)"
    if [ -n "$VRC_HOST_UUID" ] && [ -n "$host_uuid" ] && [ "$host_uuid" != "$VRC_HOST_UUID" ]; then
      return
    fi
    if [ -n "$location" ] && [ -r "$location" ]; then
      volume_label="$(blkid -o value -s LABEL "$location" 2>/dev/null | clean_one_line)"
    fi
  elif printf '%s %s' "$sr_name" "$sr_desc" | grep -qi 'xenserver tools'; then
    source_type="tools"
  fi
  if [ -z "$label" ] && [ -n "$location" ]; then
    label="$location"
  fi
  if [ -n "$label" ] || [ -n "$location" ]; then
    printf 'ISO\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$vdi" "$label" "$(num_or_zero "$virtual_size")" "$sr_uuid" "$sr_name" "$sr_desc" "$sr_shared" "$location" "$(num_or_zero "$physical_used")" "$source_type" "$volume_label" "$host_uuid"
    emitted="$emitted$vdi,"
    found="1"
  fi
}
for sr in $sr_list; do
  sr_type="$(xe sr-param-get uuid="$sr" param-name=type 2>/dev/null | clean_one_line)"
  sr_content="$(xe sr-param-get uuid="$sr" param-name=content-type 2>/dev/null | clean_one_line)"
  if [ "$sr_type" != "iso" ] && [ "$sr_content" != "iso" ]; then
    continue
  fi
  for vdi in $(xe vdi-list sr-uuid="$sr" type=iso --minimal 2>/dev/null | tr ',' ' '); do
    emit_iso "$vdi" "$sr"
  done
  # XenServer 6.x exposes ISO library entries through cd-list while their VDI type stays User.
  for cd in $(xe cd-list --minimal 2>/dev/null | tr ',' ' '); do
    emit_iso "$cd" "$sr"
  done
done
# cd-list also exposes physical optical media and XenServer 6.x ISO entries.
for cd in $(xe cd-list --minimal 2>/dev/null | tr ',' ' '); do
  emit_iso "$cd" ""
done
if [ "$found" != "1" ]; then
  for vdi in $(xe vdi-list type=iso --minimal 2>/dev/null | tr ',' ' '); do
    emit_iso "$vdi" ""
  done
fi
`;

const METRICS_SCRIPT = String.raw`
is_number() {
  echo "$1" | awk '{ exit !($1 ~ /^-?[0-9]+(\.[0-9]+)?$/) }'
}
sum_metric_family() {
  vm="$1"
  pattern="$2"
  sources="$(xe vm-data-source-list uuid="$vm" 2>/dev/null | awk -F: '/name_label/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}' | grep -E "$pattern" || true)"
  total="0"
  count="0"
  for ds in $sources; do
    value="$(xe vm-data-source-query uuid="$vm" data-source="$ds" 2>/dev/null || true)"
    if echo "$value" | awk '{ exit !($1 ~ /^-?[0-9]+(\.[0-9]+)?$/) }'; then
      total="$(awk -v a="$total" -v b="$value" 'BEGIN { printf "%.6f", a + b }')"
      count=$((count+1))
    fi
  done
  if [ "$count" = "0" ]; then
    printf ""
  else
    printf "%s" "$total"
  fi
}
vm_list="$VRC_TARGET_IDS"
if [ -z "$vm_list" ]; then
  vm_list="$(xe vm-list is-control-domain=false power-state=running --minimal 2>/dev/null | tr ',' ' ')"
fi
for vm in $vm_list; do
  power="$(xe vm-param-get uuid="$vm" param-name=power-state 2>/dev/null || true)"
  if [ "$power" != "running" ]; then
    printf 'METRIC\t%s\t\t\t\t\t\t\t\t\t\tunavailable\n' "$vm"
    continue
  fi
  vcpu_max="$(xe vm-param-get uuid="$vm" param-name=VCPUs-max 2>/dev/null || true)"
  vcpu_start="$(xe vm-param-get uuid="$vm" param-name=VCPUs-at-startup 2>/dev/null || true)"
  vcpu_live="$(xe vm-param-get uuid="$vm" param-name=VCPUs-number 2>/dev/null || true)"
  cpu_divisor="$vcpu_live"
  if [ -z "$cpu_divisor" ] || [ "$cpu_divisor" = "0" ] || [ "$cpu_divisor" = "<not in database>" ]; then
    cpu_divisor="$vcpu_start"
  fi
  if [ -z "$cpu_divisor" ] || [ "$cpu_divisor" = "0" ] || [ "$cpu_divisor" = "<not in database>" ]; then
    cpu_divisor="$vcpu_max"
  fi
  if [ -z "$cpu_divisor" ] || [ "$cpu_divisor" = "0" ] || [ "$cpu_divisor" = "<not in database>" ]; then
    cpu_divisor="$(xe vm-data-source-list uuid="$vm" 2>/dev/null | awk -F: '/name_label/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}' | grep -E '^cpu[0-9]+$' | wc -l | awk '{print $1}')"
  fi
  cpu_total="$(sum_metric_family "$vm" '^cpu[0-9]+$')"
  cpu_usage=""
  if [ -n "$cpu_total" ] && [ -n "$cpu_divisor" ] && [ "$cpu_divisor" != "0" ]; then
    cpu_usage="$(awk -v a="$cpu_total" -v c="$cpu_divisor" 'BEGIN { printf "%.6f", a / c }')"
  fi
  memory_total="$(xe vm-param-get uuid="$vm" param-name=memory-actual 2>/dev/null || true)"
  memory_free_kib="$(sum_metric_family "$vm" '^memory_internal_free$')"
  guest_tools_status="unknown"
  guest_metrics="$(xe vm-param-get uuid="$vm" param-name=guest-metrics 2>/dev/null | tr -d '\r\n' || true)"
  if [ -z "$guest_metrics" ] || [ "$guest_metrics" = "<not in database>" ]; then
    guest_tools_status="unavailable"
  else
    pv_drivers="$(xe vm-guest-metrics-param-get uuid="$guest_metrics" param-name=PV-drivers-detected 2>/dev/null | tr -d '\r\n' || true)"
    if [ "$pv_drivers" = "true" ]; then
      guest_tools_status="available"
    elif [ "$pv_drivers" = "false" ]; then
      guest_tools_status="unavailable"
    fi
  fi
  memory_used=""
  if is_number "$memory_total" && is_number "$memory_free_kib" && awk -v total="$memory_total" -v free="$memory_free_kib" 'BEGIN { exit !(total>0 && free>=0) }'; then
    memory_used="$(awk -v total="$memory_total" -v free="$memory_free_kib" 'BEGIN { used=total-(free*1024); if (used<0) used=0; if (used>total) used=total; printf "%.0f", used }')"
    guest_tools_status="available"
  elif ! is_number "$memory_total"; then
    memory_total=""
  fi
  disk_total="0"
  disk_count="0"
  for vbd in $(xe vbd-list vm-uuid="$vm" type=Disk --minimal 2>/dev/null | tr ',' ' '); do
    vdi="$(xe vbd-param-get uuid="$vbd" param-name=vdi-uuid 2>/dev/null | tr -d '\r\n')"
    [ -z "$vdi" ] && continue
    virtual_size="$(xe vdi-param-get uuid="$vdi" param-name=virtual-size 2>/dev/null | tr -d '\r\n')"
    if is_number "$virtual_size"; then
      disk_total="$(awk -v a="$disk_total" -v b="$virtual_size" 'BEGIN { printf "%.0f", a + b }')"
      disk_count=$((disk_count+1))
    fi
  done
  if [ "$disk_count" = "0" ]; then
    disk_total=""
  fi
  # XenAPI exposes VDI allocation, not guest filesystem usage. Keep disk_used empty
  # so the UI shows configured capacity without a misleading utilisation wave.
  disk_used=""
  disk_read="$(sum_metric_family "$vm" '^vbd_.*_read$')"
  disk_write="$(sum_metric_family "$vm" '^vbd_.*_write$')"
  net_rx="$(sum_metric_family "$vm" '^vif_.*_rx$')"
  net_tx="$(sum_metric_family "$vm" '^vif_.*_tx$')"
  printf 'METRIC\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$vm" "$cpu_usage" "$memory_used" "$memory_total" "$disk_used" "$disk_total" "$disk_read" "$disk_write" "$net_rx" "$net_tx" "$guest_tools_status"
done
`;

const CONSOLE_LOCATION_SCRIPT = String.raw`
clean_one_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
if [ -z "$VRC_VM_UUID" ]; then
  exit 0
fi
wait_seconds="$VRC_CONSOLE_WAIT_SECONDS"
if [ -z "$wait_seconds" ]; then
  wait_seconds="30"
fi
deadline=$(( $(date +%s) + wait_seconds ))
while true; do
  console_uuid="$(xe console-list vm-uuid="$VRC_VM_UUID" protocol=RFB --minimal 2>/dev/null | tr ',' '\n' | head -1 | clean_one_line)"
  location=""
  if [ -n "$console_uuid" ]; then
    location="$(xe console-param-get uuid="$console_uuid" param-name=location 2>/dev/null | clean_one_line)"
  fi
  if [ -n "$location" ]; then
    printf "%s" "$location"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    exit 0
  fi
  sleep 2
done
`;

interface HostInventory {
  hosts: HostNode[];
  storage: StorageRepository[];
  networks: NetworkInterface[];
}

interface ScriptOptions {
  env?: Record<string, string | undefined>;
}

export class XenServerProvider implements VirtualizationProvider<XenConnectionInput> {
  readonly type = "xenserver" as const;

  async testConnection(input: XenConnectionInput) {
    const output = await runRemoteScript(input, "hostname");
    return {
      ok: true,
      providerType: this.type,
      hostName: output.trim() || input.host,
    };
  }

  async listPools(input: XenConnectionInput): Promise<ResourcePool[]> {
    const connectionId = connectionKey(input);
    const output = await runRemoteScript(input, "xe pool-list --minimal 2>/dev/null || true");
    const poolIds = output.trim().split(",").map((item) => item.trim()).filter(Boolean);
    if (poolIds.length === 0) {
      return [
        {
          id: `${connectionId}:standalone`,
          connectionId,
          providerId: "standalone",
          name: input.host,
          type: "standalone",
        },
      ];
    }
    return poolIds.map((poolId) => ({
      id: `${connectionId}:${poolId}`,
      connectionId,
      providerId: poolId,
      name: poolId,
      type: "pool",
    }));
  }

  async listHosts(input: XenConnectionInput, _scope: ProviderScope = {}): Promise<HostNode[]> {
    return (await this.collectHostInventory(input)).hosts;
  }

  async listHostSummary(input: XenConnectionInput, hostId: string): Promise<HostNode> {
    const host = (await this.listHosts(input)).find((item) => item.providerId === hostId || item.id === hostId);
    if (!host) {
      throw new Error(`未找到 XenServer 物理机: ${hostId}`);
    }
    return host;
  }

  async summarizeVms(input: XenConnectionInput, query: VmQuery): Promise<VmInventorySummary> {
    const output = await runRemoteScript(input, VM_SUMMARY_SCRIPT, {
      env: {
        VRC_HOST_ID: sanitizeUuid(query.hostId),
      },
    });
    return parseVmSummary(output);
  }

  async listVms(input: XenConnectionInput, query: VmQuery): Promise<PagedResult<VmNode>> {
    const connectionId = connectionKey(input);
    const output = await runRemoteScript(input, VM_LIST_SCRIPT, {
      env: {
        VRC_HOST_ID: sanitizeUuid(query.hostId),
        VRC_KEYWORD: sanitizeKeyword(query.keyword),
      },
    });
    const allItems = parseVmList(output, connectionId);
    const pageSize = clampPageSize(query.pageSize);
    const page = Math.max(query.page ?? 1, 1);
    const offset = (page - 1) * pageSize;
    return {
      items: allItems.slice(offset, offset + pageSize),
      page,
      pageSize,
      total: allItems.length,
    };
  }

  async listVmSearchIndex(input: XenConnectionInput): Promise<VmSearchIndexItem[]> {
    return parseVmSearchIndex(await runRemoteScript(input, VM_SEARCH_INDEX_SCRIPT));
  }

  async listVmDisks(input: XenConnectionInput, vmId: string): Promise<VmDisk[]> {
    const output = await runRemoteScript(input, VM_DISKS_SCRIPT, {
      env: {
        VRC_VM_UUID: sanitizeUuid(vmId),
      },
    });
    return parseVmDisks(output);
  }

  async listVirtualDisks(input: XenConnectionInput, _scope: ProviderScope = {}): Promise<VirtualDisk[]> {
    return parseVirtualDisks(await runRemoteScript(input, VIRTUAL_DISKS_SCRIPT));
  }

  async listIsoImages(input: XenConnectionInput, scope: ProviderScope = {}): Promise<IsoImage[]> {
    return parseIsoImages(
      await runRemoteScript(input, ISO_IMAGES_SCRIPT, {
        env: {
          VRC_HOST_UUID: scope.hostId ? sanitizeUuid(scope.hostId) : "",
        },
      }),
    );
  }

  async listVmSnapshots(_input: XenConnectionInput, _vmId: string): Promise<VmSnapshot[]> {
    return [];
  }

  async performVmAction(input: XenConnectionInput, vmId: string, action: VmPowerAction, options?: VmActionOptions): Promise<VmActionResult> {
    const output = await runRemoteScript(input, VM_ACTION_SCRIPT, {
      env: {
        VRC_VM_UUID: vmId,
        VRC_VM_ACTION: action,
        VRC_VM_SHUTDOWN_TIMEOUT_SECONDS: String(Math.max(Math.round((options?.shutdownTimeoutMs ?? 600_000) / 1_000), 1)),
        VRC_VM_FORCE_ON_SHUTDOWN_FAILURE: options?.forceOnShutdownFailure === false ? "false" : "true",
      },
    });
    const [, , , name = vmId, forced = "false"] = output
      .trim()
      .split("\n")
      .find((line) => line.startsWith("OK\t"))
      ?.split("\t") ?? [];
    return {
      vmId,
      action,
      accepted: true,
      message:
        action === "shutdown" && forced === "true"
          ? `关机完成：${name}`
          : action === "forceReboot"
            ? `强制重启完成：${name}`
          : action === "start" && forced === "true"
            ? `开机完成：${name}`
            : `${xenActionLabel(action)}完成：${name}`,
    };
  }

  async renameVm(input: XenConnectionInput, vmId: string, currentName: string, newName: string): Promise<VmRenameResult> {
    const normalized = normalizeVmRenameInput(this.type, currentName, newName);
    let output = "";
    try {
      output = await runRemoteScript(input, VM_RENAME_SCRIPT, {
        env: {
          VRC_VM_UUID: sanitizeUuid(vmId),
          VRC_VM_CURRENT_NAME: normalized.currentName,
          VRC_VM_NEW_NAME: normalized.newName,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/名称已变更|已存在名为/.test(message)) throw new VmRenameConflictError(message);
      throw error;
    }
    const [, previousName = normalized.currentName, updatedName = normalized.newName] = output
      .trim()
      .split("\n")
      .find((line) => line.startsWith("OK\t"))
      ?.split("\t") ?? [];
    assertVmRenameCurrentName(previousName, normalized.currentName);
    return {
      vmId,
      previousName,
      newName: updatedName,
      accepted: true,
      message: `虚拟机名称已修改：${previousName} → ${updatedName}`,
    };
  }

  async resizeVm(input: XenConnectionInput, vmId: string, request: VmResizeExecutionRequest): Promise<VmResizeResult> {
    const disksBefore = request.disk ? await this.listVmDisks(input, vmId) : [];
    const targetDisk = request.disk?.mode === "extend"
      ? disksBefore.find((disk) => disk.id === request.disk?.diskId || disk.providerId === request.disk?.diskId)
      : undefined;
    const platformDiskRequest =
      request.disk?.mode === "extend" && targetDisk && request.disk.sizeBytes <= targetDisk.virtualSizeBytes
        ? undefined
        : request.disk;
    const output = await runRemoteScript(input, VM_RESIZE_SCRIPT, {
      env: {
        VRC_VM_UUID: sanitizeUuid(vmId),
        VRC_CPU_TARGET: request.cpuCount ? String(Math.floor(request.cpuCount)) : "",
        VRC_MEMORY_TARGET_BYTES: request.memoryBytes ? String(Math.floor(request.memoryBytes)) : "",
        VRC_DISK_MODE: platformDiskRequest?.mode ?? "",
        VRC_DISK_UUID: platformDiskRequest?.mode === "extend" ? sanitizeUuid(platformDiskRequest.diskId) : "",
        VRC_DISK_SR_UUID: platformDiskRequest?.mode === "add" ? sanitizeUuid(platformDiskRequest.storageRepositoryId) : "",
        VRC_DISK_SIZE_BYTES: platformDiskRequest ? String(Math.floor(platformDiskRequest.sizeBytes)) : "",
        VRC_DISK_ONLINE_RESIZE_SUPPORTED: targetDisk?.onlineResizeSupported ? "true" : "false",
        VRC_NEW_DISK_NAME: sanitizePlainText(request.disk?.name) || "VRC data disk",
        VRC_ALLOW_SHUTDOWN: request.allowShutdown ? "true" : "false",
        VRC_RESTART_AFTER_RESIZE: request.restartAfterResize ? "true" : "false",
      },
    });
    const line = output
      .trim()
      .split(/\r?\n/)
      .find((item) => item.startsWith("OK\t"));
    if (!line) throw new Error("XenServer 已执行扩容命令，但没有返回可验证结果");
    const [, resultVmId = vmId, name = vmId, oldCpu = "0", newCpu = "0", oldMemory = "0", newMemory = "0", , stopped = "false", restarted = "false"] = line.split("\t");
    const disks = await this.listVmDisks(input, vmId);
    const result: VmResizeResult = {
      vmId: resultVmId,
      name,
      accepted: true,
      previousCpuCount: parseNumber(oldCpu),
      cpuCount: parseNumber(newCpu),
      previousMemoryBytes: parseNumber(oldMemory),
      memoryBytes: parseNumber(newMemory),
      disks,
      stopped: stopped === "true",
      restarted: restarted === "true",
      message: `扩容完成：${name}`,
    };
    assertXenResizeApplied(request, disksBefore, result);
    return result;
  }

  async createVms(input: XenConnectionInput, request: VmProvisionRequest, reporter?: ProvisionProgressReporter): Promise<VmProvisionResult> {
    if (request.sourceType === "template") {
      throw new Error("XenServer 当前不使用克隆源策略；请选择 VRC 创建模板中的 ISO/Kickstart 策略。");
    }
    if (request.sourceType === "iso" && !request.isoId) {
      throw new Error("XenServer ISO 安装需要选择系统镜像。");
    }
    const selectedIso = request.sourceType === "iso" && request.isoId
      ? (await this.listIsoImages(input, { hostId: request.hostId })).find((image) => image.providerId === request.isoId || image.id === request.isoId)
      : undefined;
    const isoName = request.sourceType === "iso"
      ? selectedIso?.name || request.isoName?.trim() || request.templateName?.trim() || request.isoId || ""
      : "";
    if (request.sourceType === "iso" && isXenGuestToolsIsoName(selectedIso?.name || selectedIso?.path || isoName)) {
      throw new Error(`${isoName} 是 XenServer 监控工具盘，不能用于安装操作系统。请先接入或选择系统安装 ISO。`);
    }
    if (selectedIso?.sourceType === "host-dvd" && (!request.hostId || selectedIso.hostId !== request.hostId)) {
      throw new Error(`${isoName} 位于宿主机本地 DVD，必须在所属物理机上创建虚拟机。`);
    }
    const created: VmProvisionCreatedVm[] = [];
    for (const item of request.planItems) {
      const macAddress = macAddressForProvisionItem(item);
      reporter?.updateVm(item.name, {
        status: "running",
        currentStep: "create-vm",
        message: "准备 XenServer VM 创建参数",
      });
      const preparedMedia = await prepareXenInstallMedia({
        connection: input,
        request,
        item,
        sourceIsoName: isoName,
        sourceType: selectedIso?.sourceType,
        macAddress,
        reporter,
      });
      if (preparedMedia.requiresInstallSource && !item.installSource) {
        throw new Error("XenServer Kickstart 安装缺少集中安装源，请先发布安装源后再创建 VM。");
      }
      const isoStartedAt = Date.now();
      reporter?.recordTiming?.("xenserver-prepare-install-media", Date.now() - isoStartedAt, {
        vmName: item.name,
        installMediaMode: preparedMedia.installMediaMode,
        generatedIso: Boolean(preparedMedia.auxiliaryIsoId),
      });
      if (preparedMedia.unattended && preparedMedia.installMediaMode === "cdrom-http-ks") {
        reporter?.markStep("create-vm", "running", `${item.name}：复用原始 ISO，通过物理机 HTTP 拉取 Kickstart`);
        reporter?.updateVm(item.name, {
          status: "running",
          currentStep: "create-vm",
          message: "复用原始 ISO，通过物理机 HTTP 拉取 Kickstart",
        });
      }
      reporter?.updateVm(item.name, {
        status: "running",
        currentStep: "create-vm",
        message: "正在 XenServer 上创建 VM、磁盘、网卡并挂载安装介质",
      });
      const createScriptStartedAt = Date.now();
      let output: string;
      try {
        output = await runRemoteScript(input, VM_CREATE_SCRIPT, {
          env: {
            VRC_SOURCE_TYPE: request.sourceType,
            VRC_VM_NAME: item.name,
            VRC_IP: item.ip,
            VRC_GATEWAY: sanitizePlainText(request.ipPool.gateway),
            VRC_DNS: sanitizePlainText(request.ipPool.dns[0] ?? ""),
            VRC_NETMASK: cidrToNetmask(request.ipPool.cidr) || "255.255.255.0",
            VRC_ROOT_PASSWORD: sanitizePlainText(item.rootPassword),
            VRC_LOGIN_USERNAME: sanitizePlainText(item.loginUsername),
            VRC_HOST_UUID: sanitizeUuid(request.hostId),
            VRC_ISO_UUID: sanitizeUuid(preparedMedia.originalIsoId),
            VRC_ISO_NAME: sanitizePlainText(preparedMedia.originalIsoName),
            VRC_AUX_ISO_UUID: sanitizeUuid(preparedMedia.auxiliaryIsoId),
            VRC_INSTALL_REPO_URL: sanitizeUrl(item.installSource?.repoUrl),
            VRC_INSTALL_KS_URL: sanitizeUrl(item.installSource?.ksUrl),
            VRC_INSTALL_ARGS:
              preparedMedia.installMediaMode === "native-http"
                ? buildXenNativeInstallArgs({
                    ksUrl: sanitizeUrl(item.installSource?.ksUrl),
                    ip: item.ip,
                    gateway: request.ipPool.gateway,
                    netmask: cidrToNetmask(request.ipPool.cidr) || "255.255.255.0",
                  })
                : "",
            VRC_SOURCE_ISO_UUID: "",
            VRC_INSTALL_MEDIA_MODE: preparedMedia.installMediaMode,
            VRC_UNATTENDED_INSTALL: preparedMedia.unattended ? "true" : "false",
            VRC_MAC: sanitizeMac(macAddress),
            VRC_TEMPLATE_NAME: xenTemplateNameForProvision(request),
            VRC_CPU: String(Math.max(Math.floor(item.cpu), 1)),
            VRC_MEMORY_BYTES: String(Math.max(Math.floor(item.memoryGiB), 1) * 1024 ** 3),
            VRC_DISK_BYTES: String(Math.max(Math.floor(item.diskGiB), 1) * 1024 ** 3),
            VRC_NETWORK_NAME: sanitizePlainText(request.ipPool.networkName),
            VRC_AUTO_START: request.autoStart ? "true" : "false",
          },
        });
      } catch (error) {
        if (preparedMedia.generatedIsoRegistryId) {
          await cleanupRegisteredXenGeneratedIso(input, preparedMedia.generatedIsoRegistryId).catch(() => undefined);
        }
        throw error;
      }
      const createScriptElapsedMs = Date.now() - createScriptStartedAt;
      reporter?.recordTiming?.("xenserver-create-script-total", createScriptElapsedMs, {
        vmName: item.name,
        installMediaMode: preparedMedia.installMediaMode,
      });
      for (const timing of parseProvisionScriptTimings(output)) {
        reporter?.recordTiming?.(`xenserver-create-script:${timing.phase}`, timing.elapsedMs, {
          vmName: item.name,
          installMediaMode: preparedMedia.installMediaMode,
        });
      }
      const createdVm = parseCreatedVm(output, item);
      createdVm.generatedIsoRegistryId = preparedMedia.generatedIsoRegistryId;
      reporter?.updateVm(item.name, {
        id: createdVm.id,
        providerId: createdVm.providerId,
        powerState: createdVm.powerState,
        status: request.autoStart ? "running" : "success",
        currentStep: request.autoStart ? "boot" : "create-vm",
        progressPercent: request.autoStart ? undefined : 100,
        message: request.autoStart ? "VM 已创建并启动，等待系统安装与启动验证" : "VM 已创建，未设置自动启动",
      });
      created.push(createdVm);
    }
    return {
      accepted: true,
      providerType: this.type,
      message: created.some((vm) => Boolean(vm.generatedIsoRegistryId))
        ? `XenServer 一键安装任务已提交：${created.length} 台 VM`
        : `XenServer ISO 创建任务已提交：${created.length} 台 VM`,
      created,
    };
  }

  async collectMetrics(input: XenConnectionInput, query: MetricQuery): Promise<MetricSample[]> {
    if (query.targetType !== "vm") {
      return [];
    }
    const connectionId = query.connectionId || connectionKey(input);
    const output = await runRemoteScript(input, METRICS_SCRIPT, {
      env: {
        VRC_TARGET_IDS: query.targetIds.map(sanitizeUuid).filter(Boolean).join(" "),
      },
    });
    return parseMetricSamples(output, connectionId);
  }

  async collectHostInventory(input: XenConnectionInput): Promise<HostInventory> {
    return parseHostInventory(await runRemoteScript(input, HOST_INVENTORY_SCRIPT), connectionKey(input));
  }

  async collectOverview(input: XenConnectionInput): Promise<XenOverview> {
    const inventory = await this.collectHostInventory(input);
    const host = inventory.hosts[0];
    if (!host) {
      throw new Error("未读取到 XenServer 物理机信息，请确认账号权限和 xe 命令可用。");
    }
    const vms = await this.listVms(input, { page: 1, pageSize: 500 });
    return {
      collectedAt: new Date().toISOString(),
      host: toHostSummary(host),
      storage: inventory.storage,
      networks: inventory.networks,
      vms: vms.items.map(toLegacyVmSummary),
    };
  }
}

function xenActionLabel(action: VmPowerAction) {
  if (action === "start") return "开机";
  if (action === "shutdown") return "关机";
  if (action === "forceReboot") return "强制重启";
  return "删除";
}

function xenTemplateNameForProvision(request: VmProvisionRequest) {
  const sourceName = `${request.isoName ?? ""} ${request.templateName ?? ""} ${request.isoId ?? ""}`.toLowerCase();
  if (sourceName.includes("centos")) return "CentOS 7";
  if (sourceName.includes("2008") && sourceName.includes("windows")) return "Windows Server 2008 R2 (64-bit)";
  if (sourceName.includes("2012") && sourceName.includes("windows")) return "Windows Server 2012 R2 (64-bit)";
  return "Other install media";
}

function shouldUseXenCentosUnattendedIso(request: VmProvisionRequest, isoName: string): boolean {
  const sourceName = `${isoName} ${request.templateName ?? ""} ${request.isoId ?? ""}`.toLowerCase();
  return request.sourceType === "iso" && sourceName.includes("centos");
}

function shouldUseXenWindowsUnattended(request: VmProvisionRequest, isoName: string): boolean {
  const sourceName = `${isoName} ${request.templateName ?? ""} ${request.isoId ?? ""}`.toLowerCase();
  return request.sourceType === "iso" && request.installStrategy === "windows-unattended" && sourceName.includes("windows");
}

function parseCreatedVm(output: string, fallback: { name: string; ip: string }): VmProvisionCreatedVm {
  const line = output
    .trim()
    .split(/\r?\n/)
    .find((item) => item.startsWith("CREATED\t"));
  const [, uuid = "", name = fallback.name, powerState = "halted", ip = fallback.ip, macAddress = ""] = line?.split("\t") ?? [];
  if (!uuid) {
    throw new Error("XenServer 已返回成功但未输出新 VM UUID。");
  }
  return {
    id: uuid,
    providerId: uuid,
    name,
    powerState: powerState === "running" ? "running" : "halted",
    ip,
    macAddress: macAddress || undefined,
  };
}

function parseProvisionScriptTimings(output: string): Array<{ phase: string; elapsedMs: number }> {
  return output
    .trim()
    .split(/\r?\n/)
    .filter((item) => item.startsWith("TIMING\t"))
    .map((line) => {
      const [, phase = "", rawElapsedMs = ""] = line.split("\t");
      const elapsedMs = Number(rawElapsedMs);
      return {
        phase,
        elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
      };
    })
    .filter((item) => item.phase);
}

function runRemoteScript(input: XenConnectionInput, script: string, options: ScriptOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    conn
      .on("ready", () => {
        const envPrefix = Object.entries({ ...buildXenServerPolicyEnv(), ...(options.env ?? {}) })
          .map(([key, value]) => `${key}='${escapeShellValue(value ?? "")}'`)
          .join(" ");
        const command = `${envPrefix} bash -s <<'VRC_READ_ONLY'\n${script}\nVRC_READ_ONLY\n`;
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          stream
            .on("close", (code: number) => {
              conn.end();
              if (code !== 0) {
                reject(new Error(stderr || `XenServer read-only script exited with code ${code}`));
                return;
              }
              resolve(stdout);
            })
            .on("data", (data: Buffer) => {
              stdout += data.toString("utf8");
            })
            .stderr.on("data", (data: Buffer) => {
              stderr += data.toString("utf8");
            });
        });
      })
      .on("error", reject)
      .connect({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        readyTimeout: 15000,
        algorithms: {
          kex: ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1", "diffie-hellman-group-exchange-sha1"],
          serverHostKey: ["ssh-rsa", "ssh-dss"],
        },
      });
  });
}

function parseHostInventory(output: string, connectionId: string): HostInventory {
  const hosts: HostNode[] = [];
  const storage: StorageRepository[] = [];
  const networks: NetworkInterface[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const tag = cols[0];

    if (tag === "HOST") {
      const providerId = cols[1] ?? "";
      hosts.push({
        id: `${connectionId}:host:${providerId}`,
        connectionId,
        providerId,
        name: cols[2] ?? "",
        address: cols[3] ?? "",
        vendor: "XenServer",
        version: cols[5] ?? "",
        cpuModel: cols[6] ?? "",
        cpuCores: parseNumber(cols[7]),
        cpuSockets: parseNumber(cols[8]),
        memoryTotalBytes: gibToBytes(parseNumber(cols[9])),
        memoryFreeBytes: gibToBytes(parseNumber(cols[10])),
        uptime: cols[11] ?? "",
        status: parseBool(cols[4]) ? "online" : "offline",
      });
      continue;
    }

    if (tag === "PIF") {
      networks.push({
        hostId: cols[1] ?? "",
        device: cols[2] ?? "",
        mac: cols[3] ?? "",
        ip: cols[4] ?? "",
        netmask: cols[5] ?? "",
        gateway: cols[6] ?? "",
        management: parseBool(cols[7]),
        attached: parseBool(cols[8]),
        network: cols[9] ?? "",
      });
      continue;
    }

    if (tag === "SR") {
      const type = cols[2] ?? "";
      const shared = parseBool(cols[6]);
      storage.push({
        name: cols[1] ?? "",
        type,
        ...describeStorageRepository("xenserver", { type, shared }),
        ...normalizeStorageCapacity({
          physicalGiB: parseNumber(cols[3]),
          usedGiB: parseNumber(cols[4]),
          virtualGiB: parseNumber(cols[5]),
        }),
        shared,
      });
    }
  }

  if (hosts.length === 0) {
    throw new Error("未读取到 XenServer 物理机信息，请确认账号权限和 xe 命令可用。");
  }

  return { hosts, storage, networks };
}

function parseVmList(output: string, connectionId: string): VmNode[] {
  const policy = getRuntimePolicy();
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("VM\t"))
    .map((line) => {
      const cols = line.split("\t");
      const providerId = cols[1] ?? "";
      const name = cols[2] ?? "";
      const remoteIp = cols[11]?.trim() ?? "";
      const inferredIp = remoteIp && remoteIp !== "-" ? remoteIp : inferIpv4FromName(name, policy);
      const vm: VmNode = {
        id: `${connectionId}:vm:${providerId}`,
        connectionId,
        providerId,
        consoleRef: providerId,
        name,
        powerState: normalizePowerState(cols[3]),
        cpuCount: parseNumber(cols[4]),
        cpuStartup: parseNumber(cols[5]),
        memoryBytes: gibToBytes(parseNumber(cols[6])),
        diskVirtualBytes: parseNumber(cols[7]),
        diskCount: parseNumber(cols[8]),
        diskSizeSummary: cols[9] || undefined,
        hostId: cols[10] || undefined,
        ipAddresses: inferredIp ? [inferredIp] : [],
        guestOs: normalizeGuestOsLabel(cols[12]),
        toolsStatus: normalizeXenToolsStatus(cols[14]),
        reclaimLevel: "P3",
        reclaimReason: "",
        metadata: {
          consoleUrl: cols[13] || "",
        },
      };
      const assessment = assessVmReclaim(toLegacyVmSummary(vm));
      vm.reclaimLevel = assessment.reclaimLevel;
      vm.reclaimReason = assessment.reclaimReason;
      return vm;
    })
    .filter((vm) => vm.providerId);
}

function parseVmSearchIndex(output: string): VmSearchIndexItem[] {
  const policy = getRuntimePolicy();
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("SEARCH_VM\t"))
    .map((line) => {
      const [, providerId = "", name = "", hostId = "", ip = ""] = line.split("\t");
      const remoteIp = ip.trim();
      const inferredIp = remoteIp && remoteIp !== "-" ? remoteIp : inferIpv4FromName(name, policy);
      return {
        providerId,
        hostId: hostId && hostId !== "<not in database>" ? hostId : undefined,
        name,
        ipAddresses: inferredIp ? [inferredIp] : [],
      } satisfies VmSearchIndexItem;
    })
    .filter((item) => item.providerId);
}

function parseVmSummary(output: string): VmInventorySummary {
  const line = output.split(/\r?\n/).find((item) => item.startsWith("SUMMARY\t"));
  if (!line) {
    return {
      total: 0,
      running: 0,
      halted: 0,
      vcpu: 0,
      runningVcpu: 0,
      memoryBytes: 0,
      runningMemoryBytes: 0,
    };
  }
  const cols = line.split("\t");
  return {
    total: parseNumber(cols[1]),
    running: parseNumber(cols[2]),
    halted: parseNumber(cols[3]),
    vcpu: parseNumber(cols[4]),
    runningVcpu: parseNumber(cols[6]),
    memoryBytes: gibToBytes(parseNumber(cols[5])),
    runningMemoryBytes: gibToBytes(parseNumber(cols[7])),
  };
}

function parseVmDisks(output: string): VmDisk[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("DISK\t"))
    .map((line) => {
      const cols = line.split("\t");
      const canOnlineResize = parseBool(cols[8]);
      return {
        id: cols[1] ?? "",
        vmId: cols[2] ?? "",
        providerId: cols[1] ?? "",
        device: cols[3] ?? "",
        name: cols[4] ?? "",
        displayName: /^\d+$/.test(cols[3] ?? "") ? `磁盘 ${cols[3]}` : cols[3] || cols[4] || "虚拟硬盘",
        virtualSizeBytes: parseNumber(cols[5]),
        storageRepositoryId: cols[6] || undefined,
        storageRepository: cols[7] || undefined,
        onlineResizeSupported: canOnlineResize,
        canOnlineResize,
        requiresShutdown: !canOnlineResize,
        allowedModes: ["extend", "add"] as VmDisk["allowedModes"],
      };
    })
    .filter((disk) => disk.id)
    .sort((left, right) => left.device.localeCompare(right.device, "zh-CN", { numeric: true, sensitivity: "base" }));
}

function parseVirtualDisks(output: string): VirtualDisk[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("VDI\t"))
    .map((line) => {
      const cols = line.split("\t");
      return {
        id: cols[1] ?? "",
        providerId: cols[1] ?? "",
        name: cols[2] ?? "",
        virtualSizeBytes: parseNumber(cols[3]),
        physicalUtilisationBytes: parseNumber(cols[4]),
        storageRepositoryId: cols[5] || undefined,
        storageRepository: cols[6] || "",
        type: cols[7] || "",
        readOnly: parseBool(cols[8]),
        managed: parseBool(cols[9]),
      };
    })
    .filter((disk) => disk.id);
}

export function parseIsoImages(output: string): IsoImage[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("ISO\t"))
    .map((line) => {
      const cols = line.split("\t");
      const providerId = cols[1] ?? "";
      const sourceType: NonNullable<IsoImage["sourceType"]> = cols[10] === "host-dvd" || cols[10] === "tools" ? cols[10] : "iso-library";
      const volumeLabel = cols[11]?.trim() || "";
      return {
        id: providerId,
        providerId,
        name: sourceType === "host-dvd" && volumeLabel ? volumeLabel : cols[2] || cols[8] || providerId,
        sourceType,
        sizeBytes: parseNumber(cols[3]),
        storageRepositoryId: cols[4] || undefined,
        storageRepository: cols[5] || "",
        shared: parseBool(cols[7]),
        path: cols[8] || undefined,
        hostId: cols[12] || undefined,
        metadata: {
          srDescription: cols[6] || undefined,
          physicalUtilisationBytes: parseNumber(cols[9]),
          volumeLabel: volumeLabel || undefined,
          deviceName: sourceType === "host-dvd" ? cols[2] || undefined : undefined,
        },
      };
    })
    .filter((image) => image.id && isXenInstallMedia(image))
    .sort(compareXenInstallMedia);
}

export function resolveXenProvisionInstallMediaMode(
  sourceType: IsoImage["sourceType"],
  configuredMode: XenInstallMediaMode = resolveXenInstallMediaMode(),
): XenInstallMediaMode {
  return sourceType === "host-dvd" ? "native-http" : configuredMode;
}

export function shouldPrepareXenUnattendedIso(installMediaMode: XenInstallMediaMode): boolean {
  return installMediaMode === "http-boot-iso" || installMediaMode === "offline-iso";
}

export function buildXenNativeInstallArgs(input: {
  ksUrl: string;
  ip: string;
  gateway: string;
  netmask: string;
}): string {
  return [
    `inst.ks=${input.ksUrl.trim()}`,
    "inst.text",
    "rd.neednet=1",
    "net.ifnames=0",
    "biosdevname=0",
    `ip=${input.ip.trim()}::${input.gateway.trim()}:${input.netmask.trim()}:vrc:eth0:none`,
    "bootdev=eth0",
    "ksdevice=eth0",
  ]
    .filter(Boolean)
    .join(" ");
}

function isXenInstallMedia(image: IsoImage): boolean {
  const name = image.name.trim().toLowerCase();
  const path = (image.path ?? "").trim().toLowerCase();
  const repository = image.storageRepository.trim().toLowerCase();
  const filename = path || name;

  if (!name && !path) return false;
  if (name.startsWith("old version of ")) return false;
  if (name === "xencenter.iso" || path === "xencenter.iso") return false;
  if (isGeneratedProvisioningIso(filename)) return false;
  if (image.sourceType === "host-dvd") return (image.sizeBytes ?? 0) > 0;
  if (repository.includes("xenserver tools")) {
    return name === "xs-tools.iso" || name === "guest-tools.iso" || path.endsWith("xs-tools.iso") || path.endsWith("guest-tools.iso");
  }
  return name.endsWith(".iso") || path.endsWith(".iso");
}

function isGeneratedProvisioningIso(filename: string): boolean {
  if (!filename.startsWith("vrc-") || !filename.endsWith(".iso")) return false;
  return /-(unattended|ks|boot|full)(?:-|\.iso)/.test(filename);
}

function compareXenInstallMedia(left: IsoImage, right: IsoImage): number {
  const repositoryCompare = xenIsoRepositoryPriority(left) - xenIsoRepositoryPriority(right);
  if (repositoryCompare !== 0) return repositoryCompare;
  const nameCompare = left.name.localeCompare(right.name, "en", {
    numeric: true,
    sensitivity: "base",
  });
  if (nameCompare !== 0) return nameCompare;
  return (left.path ?? left.providerId).localeCompare(right.path ?? right.providerId, "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function xenIsoRepositoryPriority(image: IsoImage): number {
  const repository = image.storageRepository.toLowerCase();
  if (repository.includes("xenserver tools")) return 30;
  if (repository.includes("dvd drives")) return 20;
  return 10;
}

function parseMetricSamples(output: string, connectionId: string): MetricSample[] {
  const sampledAt = new Date().toISOString();
  const samples: MetricSample[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("METRIC\t")) continue;
    const cols = line.split("\t");
    const vmId = cols[1] ?? "";
    const guestStatus = cols[11] === "available" || cols[11] === "unavailable" ? cols[11] : "unknown";
    const guestTelemetry: NonNullable<MetricSample["guestTelemetry"]> = {
      status: guestStatus,
      method: "xenserver-tools",
      message:
        guestStatus === "available"
          ? "XenServer Tools 可读取 Guest 指标"
          : guestStatus === "unavailable"
            ? "XenServer Tools 不可用，使用宿主机指标"
            : "XenServer Tools 状态未知",
    };
    const values: Array<[MetricSample["metric"], number | null]> = [
      ["cpu_usage", parseNullableNumber(cols[2])],
      ["memory_used", parseNullableNumber(cols[3])],
      ["memory_total", parseNullableNumber(cols[4])],
      ["disk_used", parseNullableNumber(cols[5])],
      ["disk_total", parseNullableNumber(cols[6])],
      ["disk_read", parseNullableNumber(cols[7])],
      ["disk_write", parseNullableNumber(cols[8])],
      ["net_rx", parseNullableNumber(cols[9])],
      ["net_tx", parseNullableNumber(cols[10])],
    ];
    for (const [metric, value] of values) {
      if (value == null) continue;
      samples.push({
        id: `${connectionId}:${vmId}:${metric}:${sampledAt}`,
        connectionId,
        targetType: "vm",
        targetId: vmId,
        metric,
        value,
        unit:
          metric === "cpu_usage"
            ? "ratio"
            : metric === "memory_used" || metric === "memory_total" || metric === "disk_used" || metric === "disk_total"
              ? "bytes"
              : "bytes_per_sec",
        source: metric === "memory_used" ? "guest-tools" : "hypervisor",
        guestTelemetry,
        sampledAt,
      });
    }
  }
  return samples;
}

function toHostSummary(host: HostNode): HostSummary {
  return {
    uuid: host.providerId,
    name: host.name,
    address: host.address,
    enabled: host.status === "online",
    version: host.version,
    cpuModel: host.cpuModel,
    cpuCount: host.cpuCores,
    socketCount: host.cpuSockets,
    memoryTotalGiB: bytesToGib(host.memoryTotalBytes),
    memoryFreeGiB: bytesToGib(host.memoryFreeBytes ?? 0),
    uptime: host.uptime ?? "",
  };
}

function toLegacyVmSummary(vm: VmNode) {
  return {
    uuid: vm.providerId,
    name: vm.name,
    powerState: vm.powerState,
    vcpuMax: vm.cpuCount,
    vcpuStartup: vm.cpuStartup ?? vm.cpuCount,
    memoryGiB: bytesToGib(vm.memoryBytes),
    diskTotalGiB: bytesToGib(vm.diskVirtualBytes ?? 0),
    diskDetail: "",
    residentHost: vm.hostId ?? "",
    ipAddresses: vm.ipAddresses,
    cpuUsage: vm.metrics?.cpuUsage ?? null,
    diskReadRate: vm.metrics?.diskReadRate ?? null,
    diskWriteRate: vm.metrics?.diskWriteRate ?? null,
    networkRxRate: vm.metrics?.networkRxRate ?? null,
    networkTxRate: vm.metrics?.networkTxRate ?? null,
    reclaimLevel: vm.reclaimLevel,
    reclaimReason: vm.reclaimReason,
  };
}

export function metricSamplesToVmSnapshots(samples: MetricSample[]): VmMetricSnapshot[] {
  const byVm = new Map<string, VmMetricSnapshot>();
  for (const sample of samples) {
    const snapshot =
      byVm.get(sample.targetId) ??
      ({
        uuid: sample.targetId,
        cpuUsage: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        diskUsedBytes: null,
        diskTotalBytes: null,
        diskReadRate: null,
        diskWriteRate: null,
        networkRxRate: null,
        networkTxRate: null,
        metricSources: {},
        guestTelemetry: {
          status: "unknown",
          method: "unknown",
          message: "Guest 遥测状态未知",
        },
        sampledAt: sample.sampledAt,
      } satisfies VmMetricSnapshot);
    if (sample.metric === "cpu_usage") snapshot.cpuUsage = sample.value;
    if (sample.metric === "memory_used") snapshot.memoryUsedBytes = sample.value;
    if (sample.metric === "memory_total") snapshot.memoryTotalBytes = sample.value;
    if (sample.metric === "disk_used") snapshot.diskUsedBytes = sample.value;
    if (sample.metric === "disk_total") snapshot.diskTotalBytes = sample.value;
    if (sample.metric === "disk_read") snapshot.diskReadRate = sample.value;
    if (sample.metric === "disk_write") snapshot.diskWriteRate = sample.value;
    if (sample.metric === "net_rx") snapshot.networkRxRate = sample.value;
    if (sample.metric === "net_tx") snapshot.networkTxRate = sample.value;
    const metricGroup = metricGroupForSample(sample.metric);
    if (metricGroup) snapshot.metricSources[metricGroup] = preferMetricSource(snapshot.metricSources[metricGroup], sample.source);
    if (sample.guestTelemetry) snapshot.guestTelemetry = preferGuestTelemetry(snapshot.guestTelemetry, sample.guestTelemetry);
    byVm.set(sample.targetId, snapshot);
  }
  return Array.from(byVm.values());
}

function metricGroupForSample(metric: MetricSample["metric"]): keyof VmMetricSnapshot["metricSources"] | null {
  if (metric === "cpu_usage") return "cpu";
  if (metric === "memory_usage" || metric === "memory_used" || metric === "memory_total") return "memory";
  if (metric === "disk_used" || metric === "disk_total" || metric === "disk_read" || metric === "disk_write") return "disk";
  if (metric === "net_rx" || metric === "net_tx") return "network";
  return null;
}

function preferMetricSource(
  current: VmMetricSnapshot["metricSources"][keyof VmMetricSnapshot["metricSources"]],
  candidate: MetricSample["source"],
): MetricSample["source"] {
  const priority = { hypervisor: 0, "guest-agent": 1, "guest-tools": 1 } as const;
  return current == null || priority[candidate] >= priority[current] ? candidate : current;
}

function preferGuestTelemetry(
  current: VmMetricSnapshot["guestTelemetry"],
  candidate: NonNullable<MetricSample["guestTelemetry"]>,
): VmMetricSnapshot["guestTelemetry"] {
  const priority = { unknown: 0, unavailable: 1, probing: 2, available: 3 } as const;
  return priority[candidate.status] >= priority[current.status] ? candidate : current;
}

export async function getXenConsoleLocation(input: XenConnectionInput, vmId: string): Promise<string> {
  const output = await runRemoteScript(input, CONSOLE_LOCATION_SCRIPT, {
    env: {
      VRC_VM_UUID: sanitizeUuid(vmId),
      VRC_CONSOLE_WAIT_SECONDS: "30",
    },
  });
  return output.trim();
}

function connectionKey(input: XenConnectionInput): string {
  return `xenserver:${input.host}:${input.port}`;
}

function sanitizeUuid(value: string | undefined): string {
  return (value ?? "").replace(/[^a-fA-F0-9-]/g, "");
}

function sanitizeKeyword(value: string | undefined): string {
  return (value ?? "").replace(/['"`$\\]/g, "").slice(0, 80);
}

function sanitizePlainText(value: string | undefined): string {
  return (value ?? "").replace(/[\r\n'`"$\\]/g, "").trim().slice(0, 120);
}

function sanitizeUrl(value: string | undefined): string {
  const url = (value ?? "").trim();
  if (!/^https?:\/\/[^\s'"`$\\]+$/i.test(url)) return "";
  return url.slice(0, 500);
}

function sanitizeMac(value: string | undefined): string {
  const mac = (value ?? "").trim().toLowerCase();
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) ? mac : "";
}

function macAddressForProvisionItem(item: VmProvisionPlanItem): string {
  const octets = item.ip.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return ["02", "16", "3e", toHexByte(octets[1]), toHexByte(octets[2]), toHexByte(octets[3])].join(":");
  }
  const seed = Array.from(`${item.name}:${item.ip}`).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0);
  return ["02", "16", "3e", toHexByte(seed >>> 16), toHexByte(seed >>> 8), toHexByte(seed)].join(":");
}

function toHexByte(value: number): string {
  return (value & 0xff).toString(16).padStart(2, "0");
}

function cidrToNetmask(cidr: string | undefined): string {
  const prefix = Number((cidr ?? "").split("/")[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return "";
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((shift) => String((mask >>> shift) & 255)).join(".");
}

function escapeShellValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function clampPageSize(pageSize: number | undefined): number {
  if (!pageSize) return 100;
  return Math.min(Math.max(pageSize, 1), 500);
}

export function assertXenResizeApplied(request: VmResizeExecutionRequest, disksBefore: VmDisk[], result: VmResizeResult): void {
  if (request.cpuCount && result.cpuCount < request.cpuCount) {
    throw new Error(`CPU 扩容未生效：目标 ${request.cpuCount} vCPU，平台回读 ${result.cpuCount} vCPU`);
  }
  if (request.memoryBytes && result.memoryBytes < request.memoryBytes) {
    throw new Error(`内存扩容未生效：目标 ${request.memoryBytes} 字节，平台回读 ${result.memoryBytes} 字节`);
  }
  if (!request.disk) return;

  if (request.disk.mode === "extend") {
    const resizedDisk = result.disks.find(
      (disk) => disk.id === request.disk?.diskId || disk.providerId === request.disk?.diskId,
    );
    if (!resizedDisk) {
      throw new Error("磁盘扩容后未能回读目标磁盘");
    }
    if (resizedDisk.virtualSizeBytes < request.disk.sizeBytes) {
      throw new Error(
        `磁盘扩容未生效：目标 ${request.disk.sizeBytes} 字节，平台回读 ${resizedDisk.virtualSizeBytes} 字节`,
      );
    }
    return;
  }

  const previousDiskIds = new Set(disksBefore.flatMap((disk) => [disk.id, disk.providerId]));
  const addedDisk = result.disks.find(
    (disk) => !previousDiskIds.has(disk.id) && !previousDiskIds.has(disk.providerId) && disk.virtualSizeBytes >= request.disk!.sizeBytes,
  );
  if (!addedDisk) {
    throw new Error("新增磁盘未生效：平台回读结果中没有找到新磁盘");
  }
}

function parseNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullableNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBool(value: string | undefined): boolean {
  return value === "true";
}

function gibToBytes(value: number): number {
  return Math.round(value * 1024 * 1024 * 1024);
}

function bytesToGib(value: number): number {
  return Math.round((value / 1024 / 1024 / 1024) * 10) / 10;
}

function normalizePowerState(value: string | undefined): VmNode["powerState"] {
  if (value === "running") return "running";
  if (value === "halted") return "halted";
  if (value === "suspended") return "suspended";
  return "unknown";
}

function normalizeXenToolsStatus(value: string | undefined): VmNode["toolsStatus"] {
  if (value === "available") return "installed";
  if (value === "unavailable") return "missing";
  return "unknown";
}
