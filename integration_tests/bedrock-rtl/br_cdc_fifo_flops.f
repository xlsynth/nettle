// SPDX-License-Identifier: Apache-2.0

--top br_cdc_fifo_flops
+define+BR_DISABLE_FINAL_CHECKS
+incdir+bedrock-rtl/macros

bedrock-rtl/pkg/br_math_pkg.sv
bedrock-rtl/misc/rtl/br_misc_unused.sv
bedrock-rtl/misc/rtl/br_misc_tieoff_zero.sv
bedrock-rtl/misc/rtl/br_misc_tieoff_one.sv
bedrock-rtl/gate/rtl/br_gate_mock.sv
bedrock-rtl/delay/rtl/br_delay_nr.sv
bedrock-rtl/delay/rtl/br_delay_shift_reg.sv
bedrock-rtl/delay/rtl/br_delay_valid.sv
bedrock-rtl/demux/rtl/br_demux_bin.sv
bedrock-rtl/enc/rtl/br_enc_bin2gray.sv
bedrock-rtl/enc/rtl/br_enc_bin2onehot.sv
bedrock-rtl/enc/rtl/br_enc_gray2bin.sv
bedrock-rtl/mux/rtl/br_mux_bin.sv
bedrock-rtl/mux/rtl/br_mux_bin_structured_gates_mock.sv
bedrock-rtl/mux/rtl/br_mux_onehot.sv
bedrock-rtl/counter/rtl/br_counter.sv
bedrock-rtl/counter/rtl/br_counter_incr.sv
bedrock-rtl/flow/rtl/internal/br_flow_checks_valid_data_impl.sv
bedrock-rtl/flow/rtl/internal/br_flow_checks_valid_data_intg.sv
bedrock-rtl/flow/rtl/br_flow_reg_fwd.sv
bedrock-rtl/flow/rtl/br_flow_reg_rev.sv
bedrock-rtl/fifo/rtl/internal/br_fifo_pop_ctrl_core.sv
bedrock-rtl/fifo/rtl/internal/br_fifo_push_ctrl_core.sv
bedrock-rtl/fifo/rtl/internal/br_fifo_staging_buffer.sv
bedrock-rtl/ram/rtl/br_ram_addr_decoder.sv
bedrock-rtl/ram/rtl/br_ram_data_rd_pipe.sv
bedrock-rtl/ram/rtl/br_ram_flops_tile.sv
bedrock-rtl/ram/rtl/br_ram_flops.sv
bedrock-rtl/cdc/rtl/br_cdc_pkg.sv
bedrock-rtl/cdc/rtl/internal/br_cdc_fifo_reset_overlap_checks.sv
bedrock-rtl/cdc/rtl/internal/br_cdc_fifo_pop_flag_mgr.sv
bedrock-rtl/cdc/rtl/internal/br_cdc_fifo_push_flag_mgr.sv
bedrock-rtl/cdc/rtl/internal/br_cdc_fifo_gray_count_sync.sv
bedrock-rtl/cdc/rtl/br_cdc_bit_toggle.sv
bedrock-rtl/cdc/rtl/internal/br_cdc_fifo_pop_ctrl.sv
bedrock-rtl/cdc/rtl/internal/br_cdc_fifo_push_ctrl.sv
bedrock-rtl/cdc/rtl/br_cdc_fifo_ctrl_pop_1r1w.sv
bedrock-rtl/cdc/rtl/br_cdc_fifo_ctrl_push_1r1w.sv
bedrock-rtl/cdc/rtl/br_cdc_fifo_ctrl_1r1w.sv
bedrock-rtl/cdc/rtl/br_cdc_fifo_flops.sv
