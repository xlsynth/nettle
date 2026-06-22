// SPDX-License-Identifier: Apache-2.0

--top br_amba_axil2apb
+define+BR_DISABLE_FINAL_CHECKS
+incdir+bedrock-rtl/macros

bedrock-rtl/amba/rtl/br_amba_pkg.sv
bedrock-rtl/misc/rtl/br_misc_unused.sv
bedrock-rtl/arb/rtl/internal/br_rr_state_internal.sv
bedrock-rtl/arb/rtl/internal/br_arb_rr_internal.sv
bedrock-rtl/arb/rtl/br_arb_rr.sv
bedrock-rtl/amba/rtl/br_amba_axil2apb.sv
