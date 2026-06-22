// SPDX-License-Identifier: Apache-2.0

--top br_tracker_reorder_buffer_flops
+define+BR_DISABLE_FINAL_CHECKS
+incdir+bedrock-rtl/macros

bedrock-rtl/pkg/br_math_pkg.sv
bedrock-rtl/misc/rtl/br_misc_unused.sv
bedrock-rtl/misc/rtl/br_misc_tieoff_zero.sv
bedrock-rtl/misc/rtl/br_misc_tieoff_one.sv
bedrock-rtl/delay/rtl/br_delay.sv
bedrock-rtl/delay/rtl/br_delay_shift_reg.sv
bedrock-rtl/delay/rtl/br_delay_valid.sv
bedrock-rtl/demux/rtl/br_demux_bin.sv
bedrock-rtl/enc/rtl/br_enc_bin2onehot.sv
bedrock-rtl/enc/rtl/br_enc_countones.sv
bedrock-rtl/enc/rtl/br_enc_priority_encoder.sv
bedrock-rtl/enc/rtl/br_enc_priority_dynamic.sv
bedrock-rtl/mux/rtl/br_mux_bin.sv
bedrock-rtl/mux/rtl/br_mux_onehot.sv
bedrock-rtl/counter/rtl/br_counter.sv
bedrock-rtl/counter/rtl/br_counter_incr.sv
bedrock-rtl/arb/rtl/br_arb_multi_rr.sv
bedrock-rtl/flow/rtl/internal/br_flow_checks_valid_data_impl.sv
bedrock-rtl/flow/rtl/internal/br_flow_checks_valid_data_intg.sv
bedrock-rtl/flow/rtl/br_flow_reg_fwd.sv
bedrock-rtl/flow/rtl/br_flow_reg_rev.sv
bedrock-rtl/credit/rtl/br_credit_counter.sv
bedrock-rtl/credit/rtl/br_credit_receiver.sv
bedrock-rtl/credit/rtl/br_credit_sender.sv
bedrock-rtl/fifo/rtl/internal/br_fifo_pop_ctrl_core.sv
bedrock-rtl/fifo/rtl/internal/br_fifo_push_ctrl_core.sv
bedrock-rtl/fifo/rtl/internal/br_fifo_pop_ctrl.sv
bedrock-rtl/fifo/rtl/internal/br_fifo_push_ctrl_credit.sv
bedrock-rtl/fifo/rtl/internal/br_fifo_staging_buffer.sv
bedrock-rtl/fifo/rtl/br_fifo_ctrl_1r1w_push_credit.sv
bedrock-rtl/ram/rtl/br_ram_addr_decoder.sv
bedrock-rtl/ram/rtl/br_ram_data_rd_pipe.sv
bedrock-rtl/ram/rtl/br_ram_flops_tile.sv
bedrock-rtl/ram/rtl/br_ram_flops.sv
bedrock-rtl/fifo/rtl/br_fifo_flops_push_credit.sv
bedrock-rtl/tracker/rtl/br_tracker_reorder.sv
bedrock-rtl/tracker/rtl/br_tracker_sequence.sv
bedrock-rtl/tracker/rtl/br_tracker_reorder_buffer_ctrl_1r1w.sv
bedrock-rtl/tracker/rtl/br_tracker_reorder_buffer_flops.sv
