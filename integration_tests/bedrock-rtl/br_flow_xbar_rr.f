// SPDX-License-Identifier: Apache-2.0

--top br_flow_xbar_rr
+define+BR_DISABLE_FINAL_CHECKS
+incdir+bedrock-rtl/macros

bedrock-rtl/pkg/br_math_pkg.sv
bedrock-rtl/misc/rtl/br_misc_unused.sv
bedrock-rtl/mux/rtl/br_mux_onehot.sv
bedrock-rtl/flow/rtl/internal/br_flow_checks_valid_data_impl.sv
bedrock-rtl/flow/rtl/internal/br_flow_checks_valid_data_intg.sv
bedrock-rtl/flow/rtl/internal/br_flow_arb_core.sv
bedrock-rtl/flow/rtl/internal/br_flow_mux_core.sv
bedrock-rtl/flow/rtl/br_flow_demux_select_unstable.sv
bedrock-rtl/flow/rtl/br_flow_reg_fwd.sv
bedrock-rtl/flow/rtl/internal/br_flow_xbar_core.sv
bedrock-rtl/arb/rtl/internal/br_rr_state_internal.sv
bedrock-rtl/arb/rtl/internal/br_arb_rr_internal.sv
bedrock-rtl/flow/rtl/br_flow_xbar_rr.sv
